import { describe, expect, it } from 'vitest'
import { CodexClient, type CodexClientConfig } from '../src/providers/codex-client.js'
import { ClientAbortedError } from '../src/upstream/errors.js'
import { jsonResponse, MockUpstream } from './mock-upstream.js'

function config(overrides: Partial<CodexClientConfig> = {}, baseUrl: string): CodexClientConfig {
  return {
    baseUrl,
    connectTimeoutMs: 1000,
    requestTimeoutMs: 2000,
    maxRetries: 2,
    retryMaxDelayMs: 50,
    ...overrides,
  }
}

function tokens(accessToken = 'access-1', accountId?: string) {
  return { getAccessToken: () => Promise.resolve({ accessToken, refreshToken: 'r', expiresAt: Date.now() + 1000, ...(accountId === undefined ? {} : { accountId }) }) }
}

describe('CodexClient', () => {
  it('envia POST para /responses com Authorization Bearer do token OAuth e headers fixos', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    mock.setHandler((request, response) => {
      jsonResponse(response, 200, { ok: true })
    })
    const client = new CodexClient(config({}, base.toString()), tokens('meu-access-token', 'acct_1'))

    const exchange = await client.request({ requestId: 'req-1', body: '{}', stream: false })
    expect(exchange.response.status).toBe(200)
    exchange.dispose()

    const recorded = mock.requests[0]
    expect(recorded?.url).toBe('/responses')
    expect(recorded?.headers.authorization).toBe('Bearer meu-access-token')
    expect(recorded?.headers.originator).toBe('codex_cli_rs')
    expect(recorded?.headers['chatgpt-account-id']).toBe('acct_1')
    expect(recorded?.headers['content-type']).toBe('application/json')
    expect(recorded?.headers['accept-encoding']).toBe('identity')
    expect(recorded?.headers['user-agent']).toBe('azigate')

    await client.close()
    await mock.close()
  })

  it('usa Accept text/event-stream quando stream é true', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    mock.setHandler((_request, response) => jsonResponse(response, 200, {}))
    const client = new CodexClient(config({}, base.toString()), tokens())

    await client.request({ requestId: 'req-1', body: '{}', stream: true })
    expect(mock.requests[0]?.headers.accept).toBe('text/event-stream')

    await client.close()
    await mock.close()
  })

  it('não inclui chatgpt-account-id quando o token não tem accountId', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    mock.setHandler((_request, response) => jsonResponse(response, 200, {}))
    const client = new CodexClient(config({}, base.toString()), tokens('t'))

    await client.request({ requestId: 'req-1', body: '{}', stream: false })
    expect(mock.requests[0]?.headers['chatgpt-account-id']).toBeUndefined()

    await client.close()
    await mock.close()
  })

  it('repete em status retryable até o limite de tentativas', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    let calls = 0
    mock.setHandler((_request, response) => {
      calls += 1
      jsonResponse(response, 503, { error: 'unavailable' })
    })
    const client = new CodexClient(config({ maxRetries: 2, retryMaxDelayMs: 20 }, base.toString()), tokens())

    const exchange = await client.request({ requestId: 'req-1', body: '{}', stream: false })
    expect(exchange.response.status).toBe(503)
    expect(calls).toBe(3)

    await client.close()
    await mock.close()
  })

  it('propaga ClientAbortedError quando o sinal do cliente é abortado', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    mock.setHandler(() => {
      // nunca responde, força o cliente a abortar
    })
    const client = new CodexClient(config({}, base.toString()), tokens())
    const controller = new AbortController()
    const promise = client.request({ requestId: 'req-1', body: '{}', stream: false, signal: controller.signal })
    controller.abort()

    await expect(promise).rejects.toBeInstanceOf(ClientAbortedError)

    await client.close()
    await mock.close()
  })
})
