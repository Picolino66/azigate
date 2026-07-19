import type { AddressInfo } from 'node:net'
import type { ReadableStream } from 'node:stream/web'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import type {
  BrokerExecuteRequest,
  BrokerExecuteResponse,
  BrokerHealthResponse,
} from '../src/broker/protocol.js'
import { BROKER_PROTOCOL_VERSION } from '../src/broker/protocol.js'
import { createTestConfig, type AppConfig } from '../src/config.js'
import type { CliBrokerClientLike } from '../src/providers/broker-client.js'
import {
  CliBusyError,
  CliExecutionFailedError,
  CliTimeoutError,
} from '../src/providers/errors.js'
import { ClientAbortedError } from '../src/upstream/errors.js'
import { MockUpstream, jsonResponse } from './mock-upstream.js'

const AUTHORIZATION = { authorization: 'Bearer gateway-test-secret' }
const CHAT_HEADERS = { ...AUTHORIZATION, 'content-type': 'application/json' }

function health(codex: boolean, claude = false): BrokerHealthResponse {
  return {
    version: BROKER_PROTOCOL_VERSION,
    status: codex || claude ? 'ready' : 'degraded',
    providers: {
      codex: { available: codex },
      claude: { available: claude },
    },
  }
}

class MockBroker implements CliBrokerClientLike {
  healthResult = health(true)
  executeCalls: BrokerExecuteRequest[] = []
  executeHandler: (
    input: BrokerExecuteRequest,
    signal?: AbortSignal,
  ) => Promise<BrokerExecuteResponse> = async (input) => ({
    version: BROKER_PROTOCOL_VERSION,
    requestId: input.requestId,
    decision: { content: 'ok', toolCalls: [] },
    usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
  })

  health(): Promise<BrokerHealthResponse> {
    return Promise.resolve(this.healthResult)
  }

  async execute(input: BrokerExecuteRequest, signal?: AbortSignal): Promise<BrokerExecuteResponse> {
    this.executeCalls.push(input)
    return this.executeHandler(input, signal)
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condição não atendida dentro do prazo')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('gateway multiprovedor CLI', () => {
  let upstream: MockUpstream
  let upstreamUrl: URL
  let broker: MockBroker
  const apps: ReturnType<typeof createApp>[] = []

  beforeEach(async () => {
    upstream = new MockUpstream()
    upstreamUrl = await upstream.start()
    broker = new MockBroker()
  })

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()))
    await upstream.close()
  })

  function appFor(overrides: Partial<AppConfig> = {}): ReturnType<typeof createApp> {
    const app = createApp(
      createTestConfig({ deepseekBaseUrl: upstreamUrl, enableCodexCli: true, ...overrides }),
      { brokerClient: broker },
    )
    apps.push(app)
    return app
  }

  it('não encaminha alias reservado desabilitado para a DeepSeek', async () => {
    const response = await appFor({ enableCodexCli: false }).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'codex-cli', messages: [{ role: 'user', content: 'olá' }] },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { code: 'cli_unavailable' } })
    expect(upstream.requests).toHaveLength(0)
    expect(broker.executeCalls).toHaveLength(0)
  })

  it('mantém Claude desabilitado sem fallback para a DeepSeek', async () => {
    const response = await appFor({ enableClaudeCli: false }).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'claude-cli', messages: [{ role: 'user', content: 'olá' }] },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { code: 'cli_unavailable' } })
    expect(upstream.requests).toHaveLength(0)
    expect(broker.executeCalls).toHaveLength(0)
  })

  it('encaminha modelo fixo e reasoning_effort normalizado ao Claude', async () => {
    broker.healthResult = health(true, true)
    const response = await appFor({ enableClaudeCli: true }).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: {
        model: 'claude-cli',
        messages: [{ role: 'user', content: 'olá' }],
        reasoning_effort: 'max',
      },
    })
    expect(response.statusCode).toBe(200)
    expect(broker.executeCalls[0]).toMatchObject({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      effort: 'max',
    })
  })

  it.each([
    ['claude-cli-opus-4.6', 'xhigh', 'claude-opus-4-6', 'high'],
    ['claude-cli-opus-4.7', undefined, 'claude-opus-4-7', 'xhigh'],
    ['claude-cli-haiku-4.5', 'max', 'claude-haiku-4-5', undefined],
  ] as const)('aplica matriz de effort de %s', async (alias, requested, model, expected) => {
    broker.healthResult = health(true, true)
    const payload: Record<string, unknown> = { model: alias, messages: [] }
    if (requested !== undefined) payload.reasoning_effort = requested
    const response = await appFor({ enableClaudeCli: true }).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload,
    })
    expect(response.statusCode).toBe(200)
    expect(broker.executeCalls[0]).toMatchObject({ provider: 'claude', model })
    if (expected === undefined) expect(broker.executeCalls[0]).not.toHaveProperty('effort')
    else expect(broker.executeCalls[0]?.effort).toBe(expected)
  })

  it('rejeita reasoning_effort Claude inválido antes de chamar o broker', async () => {
    broker.healthResult = health(true, true)
    const response = await appFor({ enableClaudeCli: true }).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: {
        model: 'claude-cli',
        messages: [],
        reasoning_effort: 'extreme',
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid_cli_request' } })
    expect(broker.executeCalls).toHaveLength(0)
    expect(upstream.requests).toHaveLength(0)
  })

  it('modelo Claude fora da ALLOWED_MODELS recebe 403 sem chamar provider', async () => {
    broker.healthResult = health(true, true)
    const response = await appFor({
      enableClaudeCli: true,
      allowedModels: new Set(['claude-cli-sonnet-4.6']),
    }).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'claude-cli-fable-5', messages: [] },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'model_not_allowed' } })
    expect(broker.executeCalls).toHaveLength(0)
    expect(upstream.requests).toHaveLength(0)
  })

  it('normaliza tool call e usage do Codex para Chat Completions', async () => {
    broker.executeHandler = async (input) => ({
      version: BROKER_PROTOCOL_VERSION,
      requestId: input.requestId,
      decision: { content: null, toolCalls: [{ name: 'read_file', arguments: '{"path":"a.txt"}' }] },
      usage: { promptTokens: 8, completionTokens: 3, totalTokens: 11 },
    })
    const response = await appFor().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: {
        model: 'codex-cli',
        messages: [{ role: 'user', content: 'leia a.txt' }],
        tools: [{
          type: 'function',
          function: {
            name: 'read_file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        }],
      },
    })
    expect(response.statusCode).toBe(200)
    const payload = response.json<{
      choices: { message: { tool_calls: { id: string; function: { name: string; arguments: string } }[] }; finish_reason: string }[]
      usage: { total_tokens: number }
    }>()
    expect(payload.choices[0]?.finish_reason).toBe('tool_calls')
    expect(payload.choices[0]?.message.tool_calls[0]?.id).toMatch(/^call_/u)
    expect(payload.choices[0]?.message.tool_calls[0]).toMatchObject({
      function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
    })
    expect(payload.usage.total_tokens).toBe(11)
    expect(upstream.requests).toHaveLength(0)
  })

  it('encaminha somente o modelo interno mapeado para o alias Codex', async () => {
    const response = await appFor().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'codex-cli-luna', messages: [{ role: 'user', content: 'olá' }] },
    })
    expect(response.statusCode).toBe(200)
    expect(broker.executeCalls[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-luna',
    })
  })

  it('rejeita multimodal antes de chamar o broker', async () => {
    const response = await appFor().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: {
        model: 'codex-cli',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid_cli_request' } })
    expect(broker.executeCalls).toHaveLength(0)
  })

  it('rejeita tool call não oferecida mesmo se o broker a retornar', async () => {
    broker.executeHandler = async (input) => ({
      version: BROKER_PROTOCOL_VERSION,
      requestId: input.requestId,
      decision: { content: null, toolCalls: [{ name: 'shell_interno', arguments: '{}' }] },
    })
    const response = await appFor().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: {
        model: 'codex-cli',
        messages: [{ role: 'user', content: 'faça algo' }],
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
      },
    })
    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ error: { code: 'invalid_cli_output' } })
  })

  it('mapeia busy e timeout do broker sem retry', async () => {
    broker.executeHandler = async () => { throw new CliBusyError() }
    const busy = await appFor().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'codex-cli', messages: [] },
    })
    expect(busy.statusCode).toBe(429)
    expect(busy.json()).toMatchObject({ error: { code: 'cli_busy' } })
    expect(broker.executeCalls).toHaveLength(1)

    broker.executeHandler = async () => { throw new CliTimeoutError() }
    const timeout = await appFor().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'codex-cli', messages: [] },
    })
    expect(timeout.statusCode).toBe(504)
    expect(timeout.json()).toMatchObject({ error: { code: 'cli_timeout' } })
    expect(broker.executeCalls).toHaveLength(2)
  })

  it('combina catálogo DeepSeek com alias CLI saudável', async () => {
    upstream.setHandler((_request, response) => jsonResponse(response, 200, {
      object: 'list',
      data: [{ id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' }],
    }))
    const response = await appFor().inject({ method: 'GET', url: '/v1/models', headers: AUTHORIZATION })
    expect(response.statusCode).toBe(200)
    expect(response.json<{ data: { id: string }[] }>().data.map((model) => model.id)).toEqual([
      'deepseek-chat',
      'codex-cli-sol',
      'codex-cli-terra',
      'codex-cli-luna',
      'codex-cli-5.5',
      'codex-cli-5.4',
      'codex-cli',
    ])
  })

  it('publica aliases Claude saudáveis filtrados pela allowlist', async () => {
    upstream.setHandler((_request, response) => jsonResponse(response, 200, {
      object: 'list',
      data: [{ id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' }],
    }))
    broker.healthResult = health(true, true)
    const response = await appFor({
      enableClaudeCli: true,
      allowedModels: new Set(['deepseek-chat', 'claude-cli-opus-4.8', 'claude-cli']),
    }).inject({
      method: 'GET',
      url: '/v1/models',
      headers: AUTHORIZATION,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<{ data: { id: string }[] }>().data.map((model) => model.id)).toEqual([
      'deepseek-chat',
      'claude-cli-opus-4.8',
      'claude-cli',
    ])
  })

  it('mantém alias local quando a DeepSeek falha e retorna 503 quando todos falham', async () => {
    upstream.setHandler((_request, response) => jsonResponse(response, 503, { error: 'indisponível' }))
    const degraded = await appFor().inject({ method: 'GET', url: '/v1/models', headers: AUTHORIZATION })
    expect(degraded.statusCode).toBe(200)
    expect(degraded.json<{ data: { id: string }[] }>().data.map((model) => model.id)).toEqual([
      'codex-cli-sol',
      'codex-cli-terra',
      'codex-cli-luna',
      'codex-cli-5.5',
      'codex-cli-5.4',
      'codex-cli',
    ])

    broker.healthResult = health(false)
    const unavailable = await appFor().inject({ method: 'GET', url: '/v1/models', headers: AUTHORIZATION })
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.json()).toMatchObject({ error: { code: 'providers_unavailable' } })
  })

  it('readiness aceita degradação da DeepSeek se um alias local estiver saudável', async () => {
    upstream.setHandler((_request, response) => jsonResponse(response, 503, { error: 'indisponível' }))
    const ready = await appFor({ readyCheckUpstream: true }).inject({ method: 'GET', url: '/ready' })
    expect(ready.statusCode).toBe(200)
    broker.healthResult = health(false)
    const unavailable = await appFor({ readyCheckUpstream: true }).inject({ method: 'GET', url: '/ready' })
    expect(unavailable.statusCode).toBe(503)
  })

  it('SSE CLI envia heartbeat, decisão atômica, usage e DONE', async () => {
    broker.executeHandler = async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 35))
      return {
        version: BROKER_PROTOCOL_VERSION,
        requestId: input.requestId,
        decision: { content: 'resposta final', toolCalls: [] },
        usage: { totalTokens: 7 },
      }
    }
    const app = appFor({ cliHeartbeatIntervalMs: 10 })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: CHAT_HEADERS,
      body: JSON.stringify({ model: 'codex-cli', messages: [], stream: true }),
    })
    const body = await response.text()
    expect(body).toContain(': keep-alive')
    expect(body).toContain('resposta final')
    expect(body).toContain('"usage"')
    expect(body).toContain('data: [DONE]')
  })

  it('falha após heartbeat envia event error e encerra sem DONE', async () => {
    broker.executeHandler = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      throw new CliExecutionFailedError()
    }
    const app = appFor({ cliHeartbeatIntervalMs: 10 })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: CHAT_HEADERS,
      body: JSON.stringify({ model: 'codex-cli', messages: [], stream: true }),
    })
    const body = await response.text()
    expect(body).toContain('event: error')
    expect(body).toContain('cli_execution_failed')
    expect(body).not.toContain('data: [DONE]')
  })

  it('cancelamento do Qwen é propagado ao broker', async () => {
    let cancelled = false
    broker.executeHandler = (input, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        cancelled = true
        reject(new ClientAbortedError())
      }, { once: true })
      void input
    })
    const app = appFor({ cliHeartbeatIntervalMs: 10 })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as AddressInfo
    const abort = new AbortController()
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: CHAT_HEADERS,
      body: JSON.stringify({ model: 'codex-cli', messages: [], stream: true }),
      signal: abort.signal,
    })
    await (response.body as unknown as ReadableStream<Uint8Array>).getReader().read()
    abort.abort()
    await waitUntil(() => cancelled)
    expect(cancelled).toBe(true)
  })
})
