import { Agent, fetch, type Response } from 'undici'
import { ClientAbortedError } from '../upstream/errors.js'
import { ProviderConnectionError, ProviderTimeoutError } from './http-errors.js'
import { parseRetryAfter, RETRYABLE_STATUSES, wait } from './http-retry.js'
import type { TokenManager } from './oauth/token-store.js'

const PROVIDER = 'codex'
const CODEX_ORIGINATOR = 'codex_cli_rs'

export interface CodexClientConfig {
  baseUrl: string
  connectTimeoutMs: number
  requestTimeoutMs: number
  maxRetries: number
  retryMaxDelayMs: number
}

export interface CodexRequestInput {
  requestId: string
  body: string
  stream: boolean
  signal?: AbortSignal
}

export interface CodexExchange {
  response: Response
  didTimeout(): boolean
  dispose(): void
}

export class CodexClient {
  private readonly dispatcher: Agent

  constructor(
    private readonly config: CodexClientConfig,
    private readonly tokens: TokenManager,
  ) {
    this.dispatcher = new Agent({
      connect: { timeout: config.connectTimeoutMs },
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 120_000,
    })
  }

  async request(input: CodexRequestInput): Promise<CodexExchange> {
    const token = await this.tokens.getAccessToken()
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort(new ProviderTimeoutError(PROVIDER))
    }, this.config.requestTimeoutMs)
    timeout.unref()

    const onClientAbort = (): void => controller.abort(new ClientAbortedError())
    input.signal?.addEventListener('abort', onClientAbort, { once: true })
    const dispose = (): void => {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', onClientAbort)
    }

    const url = `${this.config.baseUrl.replace(/\/+$/u, '')}/responses`
    let attempt = 0
    try {
      while (true) {
        const response = await fetch(url, {
          method: 'POST',
          dispatcher: this.dispatcher,
          signal: controller.signal,
          redirect: 'error',
          headers: {
            authorization: `Bearer ${token.accessToken}`,
            'content-type': 'application/json',
            accept: input.stream ? 'text/event-stream' : 'application/json',
            'accept-encoding': 'identity',
            connection: 'keep-alive',
            originator: CODEX_ORIGINATOR,
            ...(token.accountId === undefined ? {} : { 'chatgpt-account-id': token.accountId }),
            'x-request-id': input.requestId,
          },
          body: input.body,
        })

        if (!RETRYABLE_STATUSES.has(response.status) || attempt >= this.config.maxRetries) {
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
      if (timedOut) throw new ProviderTimeoutError(PROVIDER)
      throw new ProviderConnectionError(PROVIDER)
    }
  }

  async close(): Promise<void> {
    await this.dispatcher.close()
  }
}
