import { Agent, fetch, type Response } from 'undici'
import type { AppConfig } from '../config.js'
import { ClientAbortedError, UpstreamConnectionError, UpstreamTimeoutError } from './errors.js'

export type UpstreamPath = 'models' | 'chat/completions'

export interface UpstreamRequest {
  path: UpstreamPath
  method: 'GET' | 'POST'
  requestId: string
  accept: 'application/json' | 'text/event-stream'
  body?: string
  signal?: AbortSignal
}

export interface UpstreamExchange {
  response: Response
  didTimeout(): boolean
  dispose(): void
}

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - Date.now())
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Operação cancelada'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('Operação cancelada'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class DeepSeekClient {
  private readonly dispatcher: Agent

  constructor(private readonly config: AppConfig) {
    this.dispatcher = new Agent({
      connect: { timeout: config.connectTimeoutMs },
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 120_000,
    })
  }

  async request(input: UpstreamRequest): Promise<UpstreamExchange> {
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort(new UpstreamTimeoutError())
    }, this.config.requestTimeoutMs)
    timeout.unref()

    const onClientAbort = (): void => controller.abort(new ClientAbortedError())
    input.signal?.addEventListener('abort', onClientAbort, { once: true })
    const dispose = (): void => {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', onClientAbort)
    }

    const url = new URL(input.path, this.config.deepseekBaseUrl)
    let attempt = 0
    try {
      while (true) {
        const response = await fetch(url, {
          method: input.method,
          dispatcher: this.dispatcher,
          signal: controller.signal,
          redirect: 'error',
          headers: {
            authorization: `Bearer ${this.config.deepseekApiKey}`,
            accept: input.accept,
            ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
            'user-agent': 'deepseek-gateway',
            'x-request-id': input.requestId,
          },
          ...(input.body === undefined ? {} : { body: input.body }),
        })

        if (!RETRYABLE_STATUSES.has(response.status) || attempt >= this.config.upstreamMaxRetries) {
          return { response, didTimeout: () => timedOut, dispose }
        }

        const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
        if (retryAfter !== undefined && retryAfter > this.config.retryMaxDelayMs) {
          return { response, didTimeout: () => timedOut, dispose }
        }
        const exponential = Math.min(this.config.retryMaxDelayMs, 100 * 2 ** attempt)
        const delay = retryAfter ?? Math.round(exponential * (0.5 + Math.random() * 0.5))
        await response.body?.cancel()
        await wait(delay, controller.signal)
        attempt += 1
      }
    } catch {
      dispose()
      if (input.signal?.aborted) throw new ClientAbortedError()
      if (timedOut) throw new UpstreamTimeoutError()
      throw new UpstreamConnectionError()
    }
  }

  async close(): Promise<void> {
    await this.dispatcher.close()
  }
}
