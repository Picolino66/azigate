import { randomUUID } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { BrokerDecision, BrokerExecuteRequest, BrokerUsage } from '../broker/protocol.js'
import type { GatewayMetrics } from '../observability/metrics.js'
import { GatewayError } from '../upstream/errors.js'

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface CompletionShape {
  id: string
  created: number
  model: string
  message: {
    role: 'assistant'
    content: string | null
    tool_calls?: OpenAiToolCall[]
  }
  finishReason: 'stop' | 'tool_calls'
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

function usagePayload(usage: BrokerUsage): NonNullable<CompletionShape['usage']> {
  return {
    ...(usage.promptTokens === undefined ? {} : { prompt_tokens: usage.promptTokens }),
    ...(usage.completionTokens === undefined ? {} : { completion_tokens: usage.completionTokens }),
    ...(usage.totalTokens === undefined ? {} : { total_tokens: usage.totalTokens }),
  }
}

function completionShape(model: string, decision: BrokerDecision, usage?: BrokerUsage): CompletionShape {
  const toolCalls = decision.toolCalls.map((call) => ({
    id: `call_${randomUUID().replaceAll('-', '')}`,
    type: 'function' as const,
    function: { name: call.name, arguments: call.arguments },
  }))
  return {
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model,
    message: {
      role: 'assistant',
      content: decision.content,
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    },
    finishReason: toolCalls.length === 0 ? 'stop' : 'tool_calls',
    ...(usage === undefined ? {} : { usage: usagePayload(usage) }),
  }
}

function observeUsage(request: FastifyRequest, usage: BrokerUsage | undefined): void {
  if (!usage) return
  if (usage.promptTokens !== undefined) request.telemetry.inputTokens = usage.promptTokens
  if (usage.completionTokens !== undefined) request.telemetry.outputTokens = usage.completionTokens
  if (usage.totalTokens !== undefined) request.telemetry.totalTokens = usage.totalTokens
  if (usage.freshInputTokens !== undefined) request.telemetry.freshInputTokens = usage.freshInputTokens
  if (usage.cachedInputTokens !== undefined) request.telemetry.cachedInputTokens = usage.cachedInputTokens
  if (usage.cacheCreationInputTokens !== undefined) {
    request.telemetry.cacheCreationInputTokens = usage.cacheCreationInputTokens
  }
  if (usage.cacheReadInputTokens !== undefined) request.telemetry.cacheReadInputTokens = usage.cacheReadInputTokens
  if (usage.reasoningOutputTokens !== undefined) {
    request.telemetry.reasoningOutputTokens = usage.reasoningOutputTokens
  }
  if (usage.estimatedCostUsd !== undefined) request.telemetry.estimatedCostUsd = usage.estimatedCostUsd
  const cacheHits = usage.cachedInputTokens ?? usage.cacheReadInputTokens
  if (cacheHits !== undefined && usage.promptTokens !== undefined && usage.promptTokens > 0) {
    request.telemetry.cacheHitPercent = Math.round((cacheHits / usage.promptTokens) * 10_000) / 100
  }
}

export function cliCompletionJson(
  model: string,
  decision: BrokerDecision,
  usage: BrokerUsage | undefined,
  request: FastifyRequest,
): object {
  const shape = completionShape(model, decision, usage)
  observeUsage(request, usage)
  return {
    id: shape.id,
    object: 'chat.completion',
    created: shape.created,
    model: shape.model,
    choices: [{ index: 0, message: shape.message, finish_reason: shape.finishReason }],
    ...(shape.usage === undefined ? {} : { usage: shape.usage }),
  }
}

function sseError(error: unknown): object {
  if (error instanceof GatewayError) {
    return { error: { message: error.publicMessage, type: 'gateway_error', code: error.code } }
  }
  return {
    error: {
      message: 'Ocorreu um erro interno inesperado',
      type: 'gateway_error',
      code: 'internal_error',
    },
  }
}

export async function streamCliCompletion(
  reply: FastifyReply,
  request: FastifyRequest,
  model: string,
  brokerRequest: BrokerExecuteRequest,
  execute: () => Promise<{ decision: BrokerDecision; usage?: BrokerUsage }>,
  heartbeatIntervalMs: number,
  metrics: GatewayMetrics,
): Promise<void> {
  let started = false
  const start = (): void => {
    if (started) return
    started = true
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': request.id,
    })
    metrics.activeStreams += 1
  }
  const heartbeat = setInterval(() => {
    if (reply.raw.destroyed || reply.raw.writableEnded) return
    start()
    reply.raw.write(': keep-alive\n\n')
  }, heartbeatIntervalMs)
  heartbeat.unref()

  try {
    const result = await execute()
    const shape = completionShape(model, result.decision, result.usage)
    observeUsage(request, result.usage)
    start()
    const delta = {
      role: 'assistant',
      ...(shape.message.content === null ? {} : { content: shape.message.content }),
      ...(shape.message.tool_calls === undefined ? {} : { tool_calls: shape.message.tool_calls }),
    }
    reply.raw.write(`data: ${JSON.stringify({
      id: shape.id,
      object: 'chat.completion.chunk',
      created: shape.created,
      model: shape.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`)
    reply.raw.write(`data: ${JSON.stringify({
      id: shape.id,
      object: 'chat.completion.chunk',
      created: shape.created,
      model: shape.model,
      choices: [{ index: 0, delta: {}, finish_reason: shape.finishReason }],
    })}\n\n`)
    if (shape.usage !== undefined) {
      reply.raw.write(`data: ${JSON.stringify({
        id: shape.id,
        object: 'chat.completion.chunk',
        created: shape.created,
        model: shape.model,
        choices: [],
        usage: shape.usage,
      })}\n\n`)
    }
    reply.raw.end('data: [DONE]\n\n')
  } catch (error) {
    if (!started) throw error
    request.telemetry.error = error instanceof Error ? error.name : 'CliStreamError'
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.end(`event: error\ndata: ${JSON.stringify(sseError(error))}\n\n`)
    }
  } finally {
    clearInterval(heartbeat)
    if (started) metrics.activeStreams -= 1
    void brokerRequest
  }
}
