import { request as httpRequest } from 'node:http'
import { Writable } from 'node:stream'
import type { ReadableStream } from 'node:stream/web'
import type { AddressInfo } from 'node:net'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { createTestConfig, type AppConfig } from '../src/config.js'
import { colorizeModelLogLine, MODEL_LOG_COLORS } from '../src/observability/log-colors.js'
import { GatewayMetrics } from '../src/observability/metrics.js'
import { MockUpstream, jsonResponse } from './mock-upstream.js'

const AUTHORIZATION = { authorization: 'Bearer gateway-test-secret' }
const CHAT_HEADERS = { ...AUTHORIZATION, 'content-type': 'application/json' }

function completion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chat-1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    ...overrides,
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condição não atendida dentro do prazo')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('gateway DeepSeek', () => {
  let upstream: MockUpstream
  let upstreamUrl: URL
  const apps: ReturnType<typeof createApp>[] = []

  beforeEach(async () => {
    upstream = new MockUpstream()
    upstreamUrl = await upstream.start()
  })

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()))
    await upstream.close()
    vi.restoreAllMocks()
  })

  function appFor(overrides: Partial<AppConfig> = {}, dependencies = {}): ReturnType<typeof createApp> {
    const app = createApp(createTestConfig({ deepseekBaseUrl: upstreamUrl, ...overrides }), dependencies)
    apps.push(app)
    return app
  }

  it('rejeita requisição sem Authorization', async () => {
    const response = await appFor().inject({ method: 'GET', url: '/v1/models' })
    expect(response.statusCode).toBe(401)
    expect(upstream.requests).toHaveLength(0)
  })

  it('rejeita chave inválida', async () => {
    const response = await appFor().inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer errada' },
    })
    expect(response.statusCode).toBe(401)
    expect(upstream.requests).toHaveLength(0)
  })

  it('aceita chave válida e substitui Authorization antes do upstream', async () => {
    upstream.setHandler((_request, response) => jsonResponse(response, 200, { object: 'list', data: [] }))
    const response = await appFor().inject({ method: 'GET', url: '/v1/models', headers: AUTHORIZATION })
    expect(response.statusCode).toBe(200)
    expect(upstream.requests[0]?.headers.authorization).toBe('Bearer deepseek-test-secret')
    expect(upstream.requests[0]?.headers.authorization).not.toContain('gateway-test-secret')
  })

  it('nunca devolve a chave real mesmo se o upstream a incluir em um erro', async () => {
    upstream.setHandler((_request, response) =>
      jsonResponse(response, 401, { error: { message: 'deepseek-test-secret inválida' } }),
    )
    const response = await appFor().inject({ method: 'GET', url: '/v1/models', headers: AUTHORIZATION })
    expect(response.statusCode).toBe(503)
    expect(response.body).not.toContain('deepseek-test-secret')
    expect(response.json()).toMatchObject({ error: { code: 'providers_unavailable' } })
  })

  it('encaminha mensagens, tools, tool_choice e campos desconhecidos sem remoção', async () => {
    upstream.setHandler((_request, response) => jsonResponse(response, 200, completion()))
    const payload = {
      model: 'modelo-teste',
      messages: [{ role: 'user', content: 'olá' }],
      tools: [{ type: 'function', function: { name: 'ler', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      reasoning: { effort: 'medium' },
      reasoning_content: 'estado opaco',
      futuro_campo: { preservado: true },
    }
    const response = await appFor().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload,
    })
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(upstream.requests[0]?.body ?? '{}')).toEqual(payload)
  })

  it('preserva tool_calls, argumentos, finish_reason e usage na resposta não streaming', async () => {
    const result = completion({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            reasoning_content: 'raciocínio opaco',
            tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'ler', arguments: '{"x":1}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })
    upstream.setHandler((_request, response) => jsonResponse(response, 200, result))
    const response = await appFor().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'modelo-teste', messages: [], stream: false },
    })
    expect(response.json()).toEqual(result)
  })

  it('preserva SSE em múltiplos chunks, usage e [DONE] progressivamente', async () => {
    upstream.setHandler((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n')
      setTimeout(() => response.write(': keep-alive\n\n'), 30)
      setTimeout(() => {
        response.write('data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n')
        response.end('data: [DONE]\n\n')
      }, 80)
    })
    const app = appFor()
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as AddressInfo
    const started = Date.now()
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: CHAT_HEADERS,
      body: JSON.stringify({ model: 'modelo-teste', messages: [], stream: true, stream_options: { include_usage: true } }),
    })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = (response.body as unknown as ReadableStream<Uint8Array> | null)?.getReader()
    const first = await reader?.read()
    expect(Date.now() - started).toBeLessThan(70)
    let body = new TextDecoder().decode(first?.value)
    while (true) {
      const chunk = await reader?.read()
      if (!chunk || chunk.done) break
      body += new TextDecoder().decode(chunk.value)
    }
    expect(body).toContain(': keep-alive')
    expect(body).toContain('"usage"')
    expect(body).toContain('data: [DONE]')
  })

  it('aborta a conexão upstream quando o cliente cancela', async () => {
    let upstreamClosed = false
    upstream.setHandler((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n')
      response.on('close', () => {
        upstreamClosed = true
      })
      const timer = setInterval(() => response.write(': keep-alive\n\n'), 20)
      response.on('close', () => clearInterval(timer))
    })
    const app = appFor()
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as AddressInfo
    const abort = new AbortController()
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: CHAT_HEADERS,
      body: JSON.stringify({ model: 'modelo-teste', messages: [], stream: true }),
      signal: abort.signal,
    })
    await response.body?.getReader().read()
    abort.abort()
    await waitUntil(() => upstreamClosed)
    expect(upstreamClosed).toBe(true)
  })

  it('mapeia timeout upstream para 504', async () => {
    upstream.setHandler(() => new Promise(() => undefined))
    const response = await appFor({ requestTimeoutMs: 40, connectTimeoutMs: 20 }).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'modelo-teste', messages: [] },
    })
    expect(response.statusCode).toBe(504)
  })

  it('preserva 429 e Retry-After do upstream', async () => {
    upstream.setHandler((_request, response) => jsonResponse(response, 429, { error: 'limite' }, { 'retry-after': '7' }))
    const response = await appFor().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'modelo-teste', messages: [] },
    })
    expect(response.statusCode).toBe(429)
    expect(response.headers['retry-after']).toBe('7')
  })

  it('preserva erro 500 do upstream', async () => {
    upstream.setHandler((_request, response) => jsonResponse(response, 500, { error: { message: 'falha segura' } }))
    const response = await appFor().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'modelo-teste', messages: [] },
    })
    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ error: { message: 'falha segura' } })
  })

  it('faz retry pequeno apenas antes de iniciar a resposta', async () => {
    let calls = 0
    upstream.setHandler((_request, response) => {
      calls += 1
      if (calls === 1) jsonResponse(response, 503, { error: 'temporário' })
      else jsonResponse(response, 200, completion())
    })
    const response = await appFor({ upstreamMaxRetries: 1 }).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'modelo-teste', messages: [] },
    })
    expect(response.statusCode).toBe(200)
    expect(calls).toBe(2)
  })

  it('não segue redirect retornado pelo upstream', async () => {
    upstream.setHandler((_request, response) => {
      response.writeHead(302, { location: `${upstreamUrl.href}destino-nao-autorizado` })
      response.end()
    })
    const response = await appFor().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'modelo-teste', messages: [] },
    })
    expect(response.statusCode).toBe(502)
    expect(upstream.requests).toHaveLength(1)
  })

  it('bloqueia modelo fora da allowlist sem chamar upstream', async () => {
    const response = await appFor({ allowedModels: new Set(['permitido']) }).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'bloqueado', messages: [] },
    })
    expect(response.statusCode).toBe(403)
    expect(upstream.requests).toHaveLength(0)
  })

  it('rejeita IP fora da allowlist', async () => {
    const response = await appFor({ allowedIps: new Set(['203.0.113.10']) }).inject({
      method: 'GET',
      url: '/v1/models',
      headers: AUTHORIZATION,
    })
    expect(response.statusCode).toBe(403)
    expect(upstream.requests).toHaveLength(0)
  })

  it('valida model e messages antes do upstream', async () => {
    const app = appFor()
    const missingModel = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { messages: [] },
    })
    const invalidMessages = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'modelo-teste', messages: 'inválido' },
    })
    expect(missingModel.statusCode).toBe(400)
    expect(invalidMessages.statusCode).toBe(400)
    expect(upstream.requests).toHaveLength(0)
  })

  it('aplica limite do corpo', async () => {
    const response = await appFor({ maxRequestBodyBytes: 100 }).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'modelo-teste', messages: [{ role: 'user', content: 'x'.repeat(200) }] },
    })
    expect(response.statusCode).toBe(413)
  })

  it('aplica rate limit local por chave e IP', async () => {
    upstream.setHandler((_request, response) => jsonResponse(response, 200, { object: 'list', data: [] }))
    const app = appFor({ rateLimitMax: 1, rateLimitIpMax: 1 })
    expect((await app.inject({ method: 'GET', url: '/v1/models', headers: AUTHORIZATION })).statusCode).toBe(200)
    const limited = await app.inject({ method: 'GET', url: '/v1/models', headers: AUTHORIZATION })
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBeDefined()
  })

  it('lista modelos, filtra allowlist e usa cache', async () => {
    upstream.setHandler((_request, response) =>
      jsonResponse(response, 200, {
        object: 'list',
        data: [
          { id: 'permitido', object: 'model', owned_by: 'deepseek' },
          { id: 'oculto', object: 'model', owned_by: 'deepseek' },
        ],
      }),
    )
    const app = appFor({ allowedModels: new Set(['permitido']) })
    const first = await app.inject({ method: 'GET', url: '/v1/models', headers: AUTHORIZATION })
    const second = await app.inject({ method: 'GET', url: '/v1/models', headers: AUTHORIZATION })
    const models = first.json<{ data: { id: string }[] }>()
    expect(models.data.map((model) => model.id)).toEqual(['permitido'])
    expect(second.statusCode).toBe(200)
    expect(upstream.requests).toHaveLength(1)
  })

  it('health não chama upstream e readiness local responde sem expor segredos', async () => {
    const app = appFor()
    const health = await app.inject({ method: 'GET', url: '/health' })
    const ready = await app.inject({ method: 'GET', url: '/ready' })
    expect(health.json()).toEqual({ status: 'ok', service: 'azigate' })
    expect(ready.json()).toEqual({ status: 'ready', service: 'azigate' })
    expect(ready.body).not.toContain('secret')
    expect(upstream.requests).toHaveLength(0)
  })

  it('readiness opcional valida conectividade sem expor o corpo upstream', async () => {
    upstream.setHandler((_request, response) => jsonResponse(response, 200, { object: 'list', data: [] }))
    const response = await appFor({ readyCheckUpstream: true }).inject({ method: 'GET', url: '/ready' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ready', service: 'azigate' })
    expect(upstream.requests[0]?.url).toBe('/models')
  })

  it('rejeita JSON inválido e Content-Type incorreto', async () => {
    const app = appFor()
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: '{invalido',
    })
    const wrongType = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...AUTHORIZATION, 'content-type': 'text/plain' },
      payload: '{}',
    })
    expect(invalid.statusCode).toBe(400)
    expect(wrongType.statusCode).toBe(415)
  })

  it('não oferece endpoint de proxy aberto', async () => {
    const response = await appFor().inject({
      method: 'POST',
      url: '/proxy?url=http://127.0.0.1',
      headers: CHAT_HEADERS,
      payload: {},
    })
    expect(response.statusCode).toBe(404)
    expect(upstream.requests).toHaveLength(0)
  })

  it('sanitiza logs e registra apenas metadados permitidos', async () => {
    let logs = ''
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logs += chunk.toString()
        callback()
      },
    })
    const logger = pino({ level: 'info', base: null }, stream)
    upstream.setHandler((_request, response) => jsonResponse(response, 200, completion()))
    const app = appFor({}, { logger })
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: {
        model: 'modelo-teste',
        messages: [{ role: 'user', content: 'PROMPT_ULTRASSECRETO' }],
        reasoning_effort: 'high',
        tools: [{ type: 'function', function: { arguments: 'ARGUMENTO_SECRETO' } }],
      },
    })
    expect(logs).toContain('modelo-teste')
    expect(logs).toContain('"effort":"high"')
    expect(logs).not.toContain('PROMPT_ULTRASSECRETO')
    expect(logs).not.toContain('ARGUMENTO_SECRETO')
    expect(logs).not.toContain('gateway-test-secret')
    expect(logs).not.toContain('deepseek-test-secret')
  })

  it('atribui uma cor distinta a cada alias conhecido nos logs de terminal', () => {
    expect(colorizeModelLogLine('{"model":"deepseek-v4-flash"}\n')).toBe(
      '{"model":"\x1b[32mdeepseek-v4-flash\x1b[0m"}\n',
    )
    expect(colorizeModelLogLine('{"model":"deepseek-v4-pro"}\n')).toBe(
      '{"model":"\x1b[34mdeepseek-v4-pro\x1b[0m"}\n',
    )
    expect(colorizeModelLogLine('{"model":"codex-cli"}\n')).toBe('{"model":"\x1b[31mcodex-cli\x1b[0m"}\n')
    expect(colorizeModelLogLine('{"model":"modelo-teste"}\n')).toBe('{"model":"modelo-teste"}\n')
    const colors = Object.values(MODEL_LOG_COLORS)
    expect(new Set(colors).size).toBe(colors.length)
    for (const model of Object.keys(MODEL_LOG_COLORS)) {
      expect(colorizeModelLogLine(`{"model":"${model}"}\n`)).toContain(`\x1b[`)
    }
  })

  it('mantém métricas internas sem endpoint público', async () => {
    const metrics = new GatewayMetrics()
    upstream.setHandler((_request, response) => jsonResponse(response, 200, completion()))
    const app = appFor({}, { metrics })
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'modelo-teste', messages: [] },
    })
    expect(metrics.snapshot()).toMatchObject({ requests_total: 1, input_tokens_total: 3, output_tokens_total: 2 })
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404)
  })

  it('gera um request ID próprio e encaminha somente headers seguros', async () => {
    upstream.setHandler((_request, response) => jsonResponse(response, 200, completion()))
    const app = appFor()
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        ...CHAT_HEADERS,
        cookie: 'nao-encaminhar=1',
        'x-forwarded-for': '10.0.0.1',
        'x-real-ip': '10.0.0.2',
        'x-request-id': 'controlado-pelo-cliente',
      },
      payload: { model: 'modelo-teste', messages: [] },
    })
    const sent = upstream.requests[0]
    expect(sent?.headers.cookie).toBeUndefined()
    expect(sent?.headers['x-forwarded-for']).toBeUndefined()
    expect(sent?.headers['x-real-ip']).toBeUndefined()
    expect(sent?.headers['x-request-id']).not.toBe('controlado-pelo-cliente')
    expect(response.headers['x-request-id']).toBe(sent?.headers['x-request-id'])
  })

  it('fecha corretamente um cliente HTTP de baixo nível', async () => {
    upstream.setHandler((_request, response) => jsonResponse(response, 200, completion()))
    const app = appFor()
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as AddressInfo
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/health',
      method: 'GET',
    })
    const statusCode = await new Promise<number>((resolve, reject) => {
      request.once('response', (response) => resolve(response.statusCode ?? 0))
      request.once('error', reject)
      request.end()
    })
    expect(statusCode).toBe(200)
  })
})
