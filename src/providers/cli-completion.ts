import type { ReadableStream } from 'node:stream/web'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Response } from 'undici'
import type { GatewayMetrics } from '../observability/metrics.js'
import type { OpenAiChunk, StreamState, TranslatedStreamStep } from '../translation/state.js'
import { ClientAbortedError, GatewayError } from '../upstream/errors.js'
import { ProviderUpstreamError } from './http-errors.js'
import { readSseEvents } from './sse-reader.js'

export interface ProviderExchange {
  response: Response
  didTimeout(): boolean
  dispose(): void
}

interface ToolCallAccumulator {
  id?: string
  name?: string
  arguments: string
}

function accumulateCompletion(chunks: readonly OpenAiChunk[], model: string): object {
  let id = 'chatcmpl'
  let created = Math.floor(Date.now() / 1000)
  let content = ''
  let reasoningContent = ''
  let finishReason: string | null = null
  let usage: OpenAiChunk['usage']
  const toolCalls = new Map<number, ToolCallAccumulator>()

  for (const chunk of chunks) {
    id = chunk.id
    created = chunk.created
    const choice = chunk.choices[0]
    if (choice) {
      if (choice.delta.content !== undefined) content += choice.delta.content
      if (choice.delta.reasoning_content !== undefined) reasoningContent += choice.delta.reasoning_content
      for (const call of choice.delta.tool_calls ?? []) {
        const existing = toolCalls.get(call.index) ?? { arguments: '' }
        if (call.id !== undefined) existing.id = call.id
        if (call.function?.name !== undefined) existing.name = call.function.name
        if (call.function?.arguments !== undefined) existing.arguments += call.function.arguments
        toolCalls.set(call.index, existing)
      }
      if (choice.finish_reason !== null) finishReason = choice.finish_reason
    }
    if (chunk.usage) usage = chunk.usage
  }

  const sortedToolCalls = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => ({
      id: call.id ?? `call_${index}`,
      type: 'function' as const,
      function: { name: call.name ?? '', arguments: call.arguments },
    }))

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: sortedToolCalls.length > 0 && content.length === 0 ? null : content,
          ...(reasoningContent.length === 0 ? {} : { reasoning_content: reasoningContent }),
          ...(sortedToolCalls.length === 0 ? {} : { tool_calls: sortedToolCalls }),
        },
        finish_reason: finishReason ?? 'stop',
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  }
}

function sanitizedStreamError(provider: string): object {
  return {
    error: {
      message: `O provedor ${provider} retornou um erro durante o streaming`,
      type: 'gateway_error',
      code: `${provider}_stream_error`,
    },
  }
}

export interface RunProviderCompletionInput<TEvent> {
  provider: string
  model: string
  wantsStream: boolean
  exchange: ProviderExchange
  request: FastifyRequest
  reply: FastifyReply
  metrics: GatewayMetrics
  createState: () => StreamState
  isEvent: (value: unknown) => value is TEvent
  translateEvent: (event: TEvent, state: StreamState) => TranslatedStreamStep
  observeUsage: (request: FastifyRequest, usage: OpenAiChunk['usage']) => void
}

export async function runProviderCompletion<TEvent>(input: RunProviderCompletionInput<TEvent>): Promise<void> {
  const { provider, model, wantsStream, exchange, request, reply, metrics, createState, isEvent, translateEvent } = input
  let started = false

  const startStream = (): void => {
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

  try {
    if (!exchange.response.ok) {
      throw new ProviderUpstreamError(provider, exchange.response.status)
    }
    const body = exchange.response.body as unknown as ReadableStream<Uint8Array> | null
    if (!body) throw new ProviderUpstreamError(provider, 502)

    const state = createState()
    const chunks: OpenAiChunk[] = []
    let errored = false

    for await (const raw of readSseEvents(body)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw.data)
      } catch {
        continue
      }
      if (!isEvent(parsed)) continue

      let step: TranslatedStreamStep
      try {
        step = translateEvent(parsed, state)
      } catch {
        errored = true
        break
      }

      if (step.errored) {
        errored = true
        break
      }
      if (wantsStream) {
        for (const chunk of step.chunks) {
          if (!started) startStream()
          reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }
      } else {
        chunks.push(...step.chunks)
      }
      if (step.done) break
    }

    const lastUsage = [...chunks].reverse().find((chunk) => chunk.usage !== undefined)?.usage
    if (lastUsage !== undefined) input.observeUsage(request, lastUsage)

    if (errored) {
      if (wantsStream && started) {
        reply.raw.end(`event: error\ndata: ${JSON.stringify(sanitizedStreamError(provider))}\n\n`)
        return
      }
      throw new ProviderUpstreamError(provider, 502)
    }

    if (wantsStream) {
      if (!started) startStream()
      reply.raw.end('data: [DONE]\n\n')
      return
    }

    await reply.send(accumulateCompletion(chunks, model))
  } catch (error) {
    if (!started) throw error
    request.telemetry.error = error instanceof Error ? error.name : 'ProviderStreamError'
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      const publicPayload =
        error instanceof GatewayError
          ? { error: { message: error.publicMessage, type: 'gateway_error', code: error.code } }
          : sanitizedStreamError(provider)
      reply.raw.end(`event: error\ndata: ${JSON.stringify(publicPayload)}\n\n`)
    }
    if (error instanceof ClientAbortedError) throw error
  } finally {
    if (started) metrics.activeStreams -= 1
    exchange.dispose()
  }
}
