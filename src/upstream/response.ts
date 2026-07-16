import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ReadableStream } from 'node:stream/web'
import type { UpstreamExchange } from './client.js'
import { ClientAbortedError, UpstreamProtocolError, UpstreamTimeoutError } from './errors.js'
import { sanitizeText } from '../observability/sanitize.js'
import type { GatewayMetrics } from '../observability/metrics.js'
import type { TokenUsage } from '../types.js'

const RESPONSE_HEADERS = ['content-type', 'cache-control', 'retry-after', 'x-request-id'] as const

export function responseHeaders(exchange: UpstreamExchange, fallbackRequestId: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const name of RESPONSE_HEADERS) {
    const value = exchange.response.headers.get(name)
    if (value) headers[name] = value
  }
  headers['x-request-id'] ??= fallbackRequestId
  return headers
}

function tokenUsage(value: unknown): TokenUsage {
  if (!value || typeof value !== 'object') return {}
  const usage = (value as { usage?: unknown }).usage
  if (!usage || typeof usage !== 'object') return {}
  const record = usage as Record<string, unknown>
  return {
    ...(typeof record.prompt_tokens === 'number' ? { inputTokens: record.prompt_tokens } : {}),
    ...(typeof record.completion_tokens === 'number' ? { outputTokens: record.completion_tokens } : {}),
    ...(typeof record.total_tokens === 'number' ? { totalTokens: record.total_tokens } : {}),
  }
}

export async function forwardBufferedResponse(
  exchange: UpstreamExchange,
  request: FastifyRequest,
  reply: FastifyReply,
  secrets: readonly string[],
): Promise<void> {
  try {
    const raw = Buffer.from(await exchange.response.arrayBuffer()).toString('utf8')
    if (exchange.didTimeout()) throw new UpstreamTimeoutError()
    const body = sanitizeText(raw, secrets)
    try {
      const usage = tokenUsage(JSON.parse(body.trim()))
      Object.assign(request.telemetry, usage)
    } catch {
      // A resposta continua opaca; parsing é usado somente para telemetria opcional.
    }
    reply.headers(responseHeaders(exchange, request.id)).code(exchange.response.status).send(Buffer.from(body))
  } catch (error) {
    if (exchange.didTimeout()) throw new UpstreamTimeoutError()
    if (error instanceof ClientAbortedError) throw error
    throw new UpstreamProtocolError()
  } finally {
    exchange.dispose()
  }
}

class SseUsageObserver {
  private readonly decoder = new TextDecoder()
  private pending = ''

  observe(chunk: Uint8Array, request: FastifyRequest): void {
    this.pending += this.decoder.decode(chunk, { stream: true })
    if (this.pending.length > 1_048_576) this.pending = ''
    const lines = this.pending.split(/\r?\n/u)
    this.pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trimStart()
      if (!data || data === '[DONE]') continue
      try {
        Object.assign(request.telemetry, tokenUsage(JSON.parse(data)))
      } catch {
        // Eventos SSE inválidos não interferem no passthrough.
      }
    }
  }
}

function waitForDrainOrClose(reply: FastifyReply): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDrain = (): void => {
      cleanup()
      resolve()
    }
    const onClose = (): void => {
      cleanup()
      reject(new ClientAbortedError())
    }
    const cleanup = (): void => {
      reply.raw.removeListener('drain', onDrain)
      reply.raw.removeListener('close', onClose)
    }
    reply.raw.once('drain', onDrain)
    reply.raw.once('close', onClose)
  })
}

export async function forwardStreamingResponse(
  exchange: UpstreamExchange,
  request: FastifyRequest,
  reply: FastifyReply,
  metrics: GatewayMetrics,
): Promise<void> {
  const headers = responseHeaders(exchange, request.id)
  headers['content-type'] ??= 'text/event-stream'
  headers['x-accel-buffering'] = 'no'
  reply.hijack()
  reply.raw.writeHead(exchange.response.status, headers)
  metrics.activeStreams += 1
  const observer = new SseUsageObserver()

  try {
    const body = exchange.response.body as unknown as ReadableStream<Uint8Array> | null
    const reader = body?.getReader()
    if (!reader) throw new UpstreamProtocolError()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      observer.observe(value, request)
      if (!reply.raw.write(Buffer.from(value))) await waitForDrainOrClose(reply)
    }
    if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end()
  } catch {
    if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end()
  } finally {
    metrics.activeStreams -= 1
    exchange.dispose()
  }
}
