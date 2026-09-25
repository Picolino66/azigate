import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify'
import { claudeAcceptsForcedToolChoice, isClaudeCliModel } from '../cli-catalog.js'
import type { AppConfig } from '../config.js'
import { publicError } from '../http/errors.js'
import { createClientAbortSignal } from '../http/client-abort.js'
import type { GatewayMetrics } from '../observability/metrics.js'
import type { AnthropicClient } from '../providers/anthropic-client.js'
import type { CodexClient } from '../providers/codex-client.js'
import { runProviderCompletion } from '../providers/cli-completion.js'
import { CliUnavailableError } from '../providers/errors.js'
import { InvalidReasoningEffortError, resolveCliEffort } from '../providers/reasoning-effort.js'
import { resolveProvider } from '../providers/registry.js'
import { isAnthropicStreamEvent, translateAnthropicEvent } from '../translation/anthropic-to-openai.js'
import { translateOpenAiToAnthropic } from '../translation/openai-to-anthropic.js'
import { translateOpenAiToResponses } from '../translation/openai-to-responses.js'
import { isResponsesStreamEvent, translateResponsesEvent } from '../translation/responses-to-openai.js'
import { createStreamState, type OpenAiChunk } from '../translation/state.js'
import type { ChatBody } from '../types.js'
import type { DeepSeekClient } from '../upstream/client.js'
import { forwardBufferedResponse, forwardStreamingResponse } from '../upstream/response.js'

const LOGGABLE_DEEPSEEK_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function contentTypeIsJson(value: string | undefined): boolean {
  return /^application\/(?:[\w!#$&^_.+-]+\+)?json(?:\s*;|$)/iu.test(value ?? '')
}

function deepseekEffortForLog(value: unknown): string {
  return typeof value === 'string' && LOGGABLE_DEEPSEEK_EFFORTS.has(value)
    ? value
    : 'não_informado'
}

function observeProviderUsage(request: FastifyRequest, usage: OpenAiChunk['usage']): void {
  if (!usage) return
  request.telemetry.usageObserved = true
  if (usage.prompt_tokens !== undefined) request.telemetry.inputTokens = usage.prompt_tokens
  if (usage.completion_tokens !== undefined) request.telemetry.outputTokens = usage.completion_tokens
  if (usage.total_tokens !== undefined) request.telemetry.totalTokens = usage.total_tokens
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens
  if (cachedTokens !== undefined) request.telemetry.cachedInputTokens = cachedTokens
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens
  if (reasoningTokens !== undefined) request.telemetry.reasoningOutputTokens = reasoningTokens
  // Parcela efetivamente reprocessada pelo provedor. O cache é subconjunto do input,
  // então a diferença nunca deveria ser negativa; o piso protege contra usage
  // inconsistente do fornecedor.
  if (usage.prompt_tokens !== undefined) {
    request.telemetry.freshInputTokens = Math.max(0, usage.prompt_tokens - (cachedTokens ?? 0))
  }
  if (cachedTokens !== undefined && usage.prompt_tokens !== undefined && usage.prompt_tokens > 0) {
    request.telemetry.cacheHitPercent = Math.round((cachedTokens / usage.prompt_tokens) * 10_000) / 100
  }
}

export function registerChatRoute(
  app: FastifyInstance,
  config: AppConfig,
  protectedHook: onRequestHookHandler,
  client: DeepSeekClient,
  codexClient: CodexClient,
  anthropicClient: AnthropicClient,
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
        if (selection.kind === 'unknown-cli') {
          request.telemetry.error = 'UnknownCliAlias'
          return reply.code(400).send(publicError('Alias CLI desconhecido; consulte GET /v1/models', 'invalid_model'))
        }
        if (selection.kind === 'deepseek') {
          request.telemetry.effort = deepseekEffortForLog(chatBody.reasoning_effort)
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

        let effort
        try {
          effort = resolveCliEffort(chatBody, selection.provider, selection.model)
        } catch (error) {
          if (!(error instanceof InvalidReasoningEffortError)) throw error
          request.telemetry.error = error.name
          return reply.code(400).send(publicError(error.message, 'invalid_reasoning_effort'))
        }
        request.telemetry.effort = effort ?? 'não_aplicável'

        if (selection.provider === 'claude') {
          request.telemetry.usageObserved = false
          const anthropicBody = translateOpenAiToAnthropic(chatBody, {
            model: selection.model,
            defaultMaxTokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
            ...(effort === undefined ? {} : { effort }),
            forcedToolChoice: isClaudeCliModel(selection.model) && claudeAcceptsForcedToolChoice(selection.model),
          })
          const exchange = await anthropicClient.request({
            requestId: request.id,
            body: JSON.stringify(anthropicBody),
            stream: true,
            signal: cancellation.signal,
          })
          request.telemetry.upstreamStatus = exchange.response.status
          await runProviderCompletion({
            provider: 'anthropic',
            model,
            wantsStream: stream,
            exchange,
            request,
            reply,
            metrics,
            createState: () => createStreamState(model, `chatcmpl-${request.id}`),
            isEvent: isAnthropicStreamEvent,
            translateEvent: translateAnthropicEvent,
            observeUsage: observeProviderUsage,
          })
          return
        }

        const { request: responsesBody, metrics: promptMetrics } = translateOpenAiToResponses(chatBody, {
          model: selection.model,
          ...(effort === undefined ? {} : { effort }),
        })
        const serializedBody = JSON.stringify(responsesBody)
        // Registrado antes da chamada: um turno que falhe sem `usage` continua medido
        // pelo tamanho e pela forma do prompt (TOK-006).
        request.telemetry.usageObserved = false
        if (promptMetrics.promptCacheKey !== undefined) {
          request.telemetry.promptCacheKey = promptMetrics.promptCacheKey
        }
        request.telemetry.prefixFingerprint = promptMetrics.prefixFingerprint
        request.telemetry.requestBodyBytes = Buffer.byteLength(serializedBody)
        request.telemetry.inputItemCount = promptMetrics.inputItemCount
        request.telemetry.toolCount = promptMetrics.toolCount
        request.telemetry.toolSchemaBytes = promptMetrics.toolSchemaBytes
        const exchange = await codexClient.request({
          requestId: request.id,
          body: serializedBody,
          stream: true,
          signal: cancellation.signal,
        })
        request.telemetry.retryCount = exchange.retryCount
        request.telemetry.upstreamStatus = exchange.response.status
        await runProviderCompletion({
          provider: 'codex',
          model,
          wantsStream: stream,
          exchange,
          request,
          reply,
          metrics,
          createState: () => createStreamState(model, `chatcmpl-${request.id}`),
          isEvent: isResponsesStreamEvent,
          translateEvent: translateResponsesEvent,
          observeUsage: observeProviderUsage,
        })
        return
      } finally {
        cancellation.cleanup()
      }
    },
  )
}
