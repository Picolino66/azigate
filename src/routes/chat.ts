import type { FastifyInstance, onRequestHookHandler } from 'fastify'
import type { AppConfig } from '../config.js'
import { publicError } from '../http/errors.js'
import { createClientAbortSignal } from '../http/client-abort.js'
import type { GatewayMetrics } from '../observability/metrics.js'
import type { CliBrokerClientLike } from '../providers/broker-client.js'
import { CliRequestValidationError, normalizeCliRequest, validateCliDecision } from '../providers/cli-request.js'
import { CliUnavailableError } from '../providers/errors.js'
import { cliCompletionJson, streamCliCompletion } from '../providers/openai-response.js'
import { resolveProvider } from '../providers/registry.js'
import type { ChatBody } from '../types.js'
import type { DeepSeekClient } from '../upstream/client.js'
import { forwardBufferedResponse, forwardStreamingResponse } from '../upstream/response.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function contentTypeIsJson(value: string | undefined): boolean {
  return /^application\/(?:[\w!#$&^_.+-]+\+)?json(?:\s*;|$)/iu.test(value ?? '')
}

export function registerChatRoute(
  app: FastifyInstance,
  config: AppConfig,
  protectedHook: onRequestHookHandler,
  client: DeepSeekClient,
  broker: CliBrokerClientLike,
  metrics: GatewayMetrics,
): void {
  app.post(
    '/v1/chat/completions',
    {
      onRequest: [
        protectedHook,
        async (request, reply) => {
          if (!contentTypeIsJson(request.headers['content-type'])) {
            await reply.code(415).send(publicError('Content-Type deve ser application/json', 'unsupported_media_type'))
          }
        },
      ],
    },
    async (request, reply) => {
      if (!isRecord(request.body)) {
        request.telemetry.error = 'InvalidRequest'
        return reply.code(400).send(publicError('O corpo precisa ser um objeto JSON', 'invalid_request'))
      }
      const { model, messages } = request.body
      if (typeof model !== 'string' || model.trim() === '') {
        request.telemetry.error = 'InvalidModel'
        return reply.code(400).send(publicError('O campo model é obrigatório', 'invalid_model'))
      }
      if (!Array.isArray(messages)) {
        request.telemetry.error = 'InvalidMessages'
        return reply.code(400).send(publicError('O campo messages deve ser um array', 'invalid_messages'))
      }
      if (config.allowedModels.size > 0 && !config.allowedModels.has(model)) {
        request.telemetry.error = 'ModelNotAllowed'
        return reply.code(403).send(publicError('O modelo solicitado não é permitido', 'model_not_allowed'))
      }

      const chatBody = request.body as ChatBody
      const stream = chatBody.stream === true
      request.telemetry.model = model
      request.telemetry.stream = stream
      const cancellation = createClientAbortSignal(request, reply)
      const selection = resolveProvider(model, config)

      try {
        if (selection.kind === 'deepseek') {
          const exchange = await client.request({
            path: 'chat/completions',
            method: 'POST',
            requestId: request.id,
            accept: stream ? 'text/event-stream' : 'application/json',
            body: JSON.stringify(chatBody),
            signal: cancellation.signal,
          })
          request.telemetry.upstreamStatus = exchange.response.status
          if (!exchange.response.ok || !stream) {
            await forwardBufferedResponse(exchange, request, reply, [config.deepseekApiKey, ...config.gatewayApiKeys])
            return
          }
          await forwardStreamingResponse(exchange, request, reply, metrics)
          return
        }

        if (!selection.enabled) throw new CliUnavailableError()
        let brokerRequest
        try {
          brokerRequest = normalizeCliRequest(chatBody, request.id, selection.provider, selection.model)
        } catch (error) {
          if (!(error instanceof CliRequestValidationError)) throw error
          request.telemetry.error = error.name
          return reply.code(400).send(publicError(error.publicMessage, 'invalid_cli_request'))
        }
        const execute = async () => {
          const result = await broker.execute(brokerRequest, cancellation.signal)
          return { decision: validateCliDecision(result.decision, brokerRequest), ...(result.usage ? { usage: result.usage } : {}) }
        }
        if (stream) {
          await streamCliCompletion(
            reply,
            request,
            model,
            brokerRequest,
            execute,
            config.cliHeartbeatIntervalMs,
            metrics,
          )
          return
        }
        const result = await execute()
        return reply.send(cliCompletionJson(model, result.decision, result.usage, request))
      } finally {
        cancellation.cleanup()
      }
    },
  )
}
