import { describe, expect, it } from 'vitest'
import { AnthropicClient, type AnthropicClientConfig } from '../src/providers/anthropic-client.js'
import { ClientAbortedError } from '../src/upstream/errors.js'
import { jsonResponse, MockUpstream } from './mock-upstream.js'

function config(overrides: Partial<AnthropicClientConfig> = {}, baseUrl: string): AnthropicClientConfig {
  return {
    baseUrl,
    connectTimeoutMs: 1000,
    requestTimeoutMs: 2000,
    maxRetries: 2,
    retryMaxDelayMs: 50,
    ...overrides,
  }
}

function tokens(accessToken = 'access-1') {
  return { getAccessToken: () => Promise.resolve({ accessToken, refreshToken: 'r', expiresAt: Date.now() + 1000 }) }
}

describe('AnthropicClient', () => {
  it('envia POST para /v1/messages com Authorization Bearer e headers Anthropic fixos', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    mock.setHandler((_request, response) => jsonResponse(response, 200, { ok: true }))
    const client = new AnthropicClient(config({}, base.toString()), tokens('token-oauth'))

    const exchange = await client.request({ requestId: 'req-1', body: '{}', stream: false })
    expect(exchange.response.status).toBe(200)
    exchange.dispose()

    const recorded = mock.requests[0]
    expect(recorded?.url).toBe('/v1/messages')
    expect(recorded?.headers.authorization).toBe('Bearer token-oauth')
    expect(recorded?.headers['anthropic-version']).toBe('2023-06-01')
    expect(recorded?.headers['anthropic-beta']).toContain('oauth-2025-04-20')
    expect(recorded?.headers['x-app']).toBe('cli')
    expect(recorded?.headers['accept-encoding']).toBe('identity')

    await client.close()
    await mock.close()
  })

  it('usa Accept text/event-stream quando stream é true', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    mock.setHandler((_request, response) => jsonResponse(response, 200, {}))
    const client = new AnthropicClient(config({}, base.toString()), tokens())

    await client.request({ requestId: 'req-1', body: '{}', stream: true })
    expect(mock.requests[0]?.headers.accept).toBe('text/event-stream')

    await client.close()
    await mock.close()
  })

  it('repete em status retryable até o limite de tentativas', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    let calls = 0
    mock.setHandler((_request, response) => {
      calls += 1
      jsonResponse(response, 429, { error: 'rate_limited' })
    })
    const client = new AnthropicClient(config({ maxRetries: 1, retryMaxDelayMs: 20 }, base.toString()), tokens())

    const exchange = await client.request({ requestId: 'req-1', body: '{}', stream: false })
    expect(exchange.response.status).toBe(429)
    expect(calls).toBe(2)

    await client.close()
    await mock.close()
  })

  it('não repete em status não configurado como retryable (ex.: 400)', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    let calls = 0
    mock.setHandler((_request, response) => {
      calls += 1
      jsonResponse(response, 400, { error: 'bad_request' })
    })
    const client = new AnthropicClient(config({ maxRetries: 3, retryMaxDelayMs: 20 }, base.toString()), tokens())

    const exchange = await client.request({ requestId: 'req-1', body: '{}', stream: false })
    expect(exchange.response.status).toBe(400)
    expect(calls).toBe(1)

    await client.close()
    await mock.close()
  })

  it('propaga ClientAbortedError quando o sinal do cliente é abortado', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    mock.setHandler(() => {
      // nunca responde, força o cliente a abortar
    })
    const client = new AnthropicClient(config({}, base.toString()), tokens())
    const controller = new AbortController()
    const promise = client.request({ requestId: 'req-1', body: '{}', stream: false, signal: controller.signal })
    controller.abort()

    await expect(promise).rejects.toBeInstanceOf(ClientAbortedError)

    await client.close()
    await mock.close()
  })
})
