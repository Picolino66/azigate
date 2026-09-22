import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReadableStream } from 'node:stream/web'
import { Writable } from 'node:stream'
import type { ServerResponse } from 'node:http'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppDependencies } from '../src/app.js'
import { createTestConfig, type AppConfig } from '../src/config.js'
import { GatewayMetrics } from '../src/observability/metrics.js'
import { writeTokenFile } from '../src/providers/oauth/token-store.js'
import { jsonResponse, MockUpstream, type RecordedRequest } from './mock-upstream.js'

const AUTHORIZATION = { authorization: 'Bearer gateway-test-secret' }
const CHAT_HEADERS = { ...AUTHORIZATION, 'content-type': 'application/json' }

type SseEventData = Record<string, unknown> & { type: string }

function sse(events: SseEventData[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function sseResponse(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/event-stream' })
  response.end(body)
}

function anthropicTextEvents(text: string, usage: { input?: number; output?: number } = {}): SseEventData[] {
  return [
    { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: usage.input ?? 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output ?? 3 } },
    { type: 'message_stop' },
  ]
}

function anthropicToolCallEvents(callId: string, name: string, args: string): SseEventData[] {
  return [
    { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 8 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: callId, name } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]
}

function responsesTextEvents(text: string): SseEventData[] {
  return [
    { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.4', created_at: 1 } },
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } },
  ]
}

function responsesToolCallEvents(callId: string, name: string, args: string): SseEventData[] {
  return [
    { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.4', created_at: 1 } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'item_1', call_id: callId, name },
    },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: args },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: args },
    { type: 'response.completed', response: { usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } } },
  ]
}

function requestBodies(mock: MockUpstream): Record<string, unknown>[] {
  return mock.requests.map((request: RecordedRequest) => JSON.parse(request.body) as Record<string, unknown>)
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condição não atendida dentro do prazo')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('gateway multiprovedor CLI (adaptadores HTTP nativos)', () => {
  let deepseek: MockUpstream
  let deepseekUrl: URL
  let codex: MockUpstream
  let codexUrl: URL
  let claude: MockUpstream
  let claudeUrl: URL
  let secretsDir: string
  let codexTokenFile: string
  let claudeTokenFile: string
  const apps: ReturnType<typeof createApp>[] = []

  beforeEach(async () => {
    deepseek = new MockUpstream()
    deepseekUrl = await deepseek.start()
    codex = new MockUpstream()
    codexUrl = await codex.start()
    claude = new MockUpstream()
    claudeUrl = await claude.start()

    secretsDir = await mkdtemp(join(tmpdir(), 'azigate-oauth-'))
    codexTokenFile = join(secretsDir, 'codex-oauth.json')
    claudeTokenFile = join(secretsDir, 'claude-oauth.json')
    await writeTokenFile(codexTokenFile, {
      accessToken: 'codex-access-token',
      refreshToken: 'codex-refresh-token',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'acct_codex',
    })
    await writeTokenFile(claudeTokenFile, {
      accessToken: 'claude-access-token',
      refreshToken: 'claude-refresh-token',
      expiresAt: Date.now() + 3_600_000,
    })
  })

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()))
    await Promise.all([deepseek.close(), codex.close(), claude.close()])
    await rm(secretsDir, { recursive: true, force: true })
  })

  function appFor(overrides: Partial<AppConfig> = {}, dependencies: AppDependencies = {}): ReturnType<typeof createApp> {
    const app = createApp(
      createTestConfig({
        deepseekBaseUrl: deepseekUrl,
        codexBaseUrl: codexUrl,
        claudeBaseUrl: claudeUrl,
        codexTokenFile,
        claudeTokenFile,
        enableCodexCli: true,
        ...overrides,
      }),
      dependencies,
    )
    apps.push(app)
    return app
  }

  it('não encaminha alias reservado desabilitado para a DeepSeek nem para o provedor', async () => {
    const response = await appFor({ enableCodexCli: false }).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'codex-cli', messages: [{ role: 'user', content: 'olá' }] },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { code: 'cli_unavailable' } })
    expect(deepseek.requests).toHaveLength(0)
    expect(codex.requests).toHaveLength(0)
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
    expect(claude.requests).toHaveLength(0)
  })

  it('completude Claude não-streaming: traduz requisição, chama a Messages API e devolve chat.completion', async () => {
    claude.setHandler((_request, response) => sseResponse(response, 200, sse(anthropicTextEvents('olá, tudo bem?'))))
    const response = await appFor({ enableClaudeCli: true }).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'claude-cli', messages: [{ role: 'user', content: 'oi' }], reasoning_effort: 'max' },
    })
    expect(response.statusCode).toBe(200)
    const payload = response.json<{
      object: string
      choices: { message: { content: string }; finish_reason: string }[]
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    }>()
    expect(payload.object).toBe('chat.completion')
    expect(payload.choices[0]?.message.content).toBe('olá, tudo bem?')
    expect(payload.choices[0]?.finish_reason).toBe('stop')
    expect(payload.usage).toEqual({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 })

    expect(claude.requests[0]?.url).toBe('/v1/messages')
    expect(claude.requests[0]?.headers.authorization).toBe('Bearer claude-access-token')
    const [sent] = requestBodies(claude)
    expect(sent).toMatchObject({ model: 'claude-sonnet-4-6' })
  })

  it('completude Codex não-streaming: traduz requisição, chama a Responses API e normaliza max para xhigh', async () => {
    codex.setHandler((_request, response) => sseResponse(response, 200, sse(responsesTextEvents('pronto'))))
    const response = await appFor().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'codex-cli-sol', messages: [{ role: 'user', content: 'oi' }], reasoning: { effort: 'max' } },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ choices: [{ message: { content: 'pronto' }, finish_reason: 'stop' } ] })
    expect(codex.requests[0]?.url).toBe('/responses')
    expect(codex.requests[0]?.headers.authorization).toBe('Bearer codex-access-token')
    expect(codex.requests[0]?.headers['chatgpt-account-id']).toBe('acct_codex')
    const [sent] = requestBodies(codex)
    expect(sent).toMatchObject({ model: 'gpt-5.6-sol', reasoning: { effort: 'xhigh', summary: 'auto' } })
  })

  it('completude em streaming devolve chunks incrementais e termina com [DONE]', async () => {
    claude.setHandler((_request, response) => sseResponse(response, 200, sse(anthropicTextEvents('fluxo real'))))
    const app = appFor({ enableClaudeCli: true })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: CHAT_HEADERS,
      body: JSON.stringify({ model: 'claude-cli', messages: [{ role: 'user', content: 'oi' }], stream: true }),
    })
    const body = await response.text()
    expect(body).toContain('chat.completion.chunk')
    expect(body).toContain('fluxo real')
    expect(body).toContain('"finish_reason":"stop"')
    expect(body).toContain('data: [DONE]')
  })

  it('tool calling multi-turn Codex: tool_calls -> tool result -> resposta final', async () => {
    codex.setHandler((request, response) => {
      const parsed = JSON.parse(request.body) as { input: Array<{ type: string }> }
      const hasToolOutput = parsed.input.some((item) => item.type === 'function_call_output')
      const body = hasToolOutput
        ? responsesTextEvents('concluído')
        : responsesToolCallEvents('call_1', 'read_file', '{"path":"a.txt"}')
      sseResponse(response, 200, sse(body))
    })
    const first = await appFor().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: {
        model: 'codex-cli',
        messages: [{ role: 'user', content: 'leia a.txt' }],
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
      },
    })
    expect(first.statusCode).toBe(200)
    const toolCall = first.json<{ choices: { message: { tool_calls: { id: string; function: { arguments: string } }[] } }[] }>()
      .choices[0]?.message.tool_calls[0]
    expect(toolCall?.id).toBe('call_1')
    expect(toolCall?.function.arguments).toBe('{"path":"a.txt"}')

    const second = await appFor().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: {
        model: 'codex-cli',
        messages: [
          { role: 'user', content: 'leia a.txt' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'conteúdo do arquivo' },
        ],
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
      },
    })
    expect(second.statusCode).toBe(200)
    expect(second.json()).toMatchObject({ choices: [{ message: { content: 'concluído' } }] })
  })

  it('tool calling multi-turn Claude', async () => {
    claude.setHandler((request, response) => {
      const parsed = JSON.parse(request.body) as { messages: Array<{ role: string; content: unknown[] }> }
      const hasToolResult = parsed.messages.some(
        (message) => Array.isArray(message.content) && message.content.some((part) => isRecord(part) && part.type === 'tool_result'),
      )
      const body = hasToolResult
        ? anthropicTextEvents('concluído')
        : anthropicToolCallEvents('toolu_1', 'read_file', '{"path":"a.txt"}')
      sseResponse(response, 200, sse(body))
    })
    function isRecord(value: unknown): value is Record<string, unknown> {
      return value !== null && typeof value === 'object'
    }
    const first = await appFor({ enableClaudeCli: true }).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: {
        model: 'claude-cli',
        messages: [{ role: 'user', content: 'leia a.txt' }],
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
      },
    })
    expect(first.statusCode).toBe(200)
    const toolCall = first.json<{ choices: { message: { tool_calls: { id: string }[] } }[] }>().choices[0]?.message
      .tool_calls[0]
    expect(toolCall?.id).toBe('toolu_1')

    const second = await appFor({ enableClaudeCli: true }).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: {
        model: 'claude-cli',
        messages: [
          { role: 'user', content: 'leia a.txt' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
          },
          { role: 'tool', tool_call_id: 'toolu_1', content: 'conteúdo do arquivo' },
        ],
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
      },
    })
    expect(second.statusCode).toBe(200)
    expect(second.json()).toMatchObject({ choices: [{ message: { content: 'concluído' } }] })
  })

  it('rejeita reasoning_effort inválido antes de chamar o provedor', async () => {
    const response = await appFor({ enableClaudeCli: true }).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'claude-cli', messages: [], reasoning_effort: 'extreme' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid_reasoning_effort' } })
    expect(claude.requests).toHaveLength(0)
  })

  it('modelo fora da ALLOWED_MODELS recebe 403 sem chamar o provedor', async () => {
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
    expect(claude.requests).toHaveLength(0)
  })

  it('mapeia erro do provedor sem vazar o corpo bruto da resposta', async () => {
    codex.setHandler((_request, response) => jsonResponse(response, 500, { error: { message: 'segredo interno do provedor' } }))
    const response = await appFor().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'codex-cli', messages: [] },
    })
    expect(response.statusCode).toBe(500)
    expect(response.json()).toMatchObject({ error: { code: 'codex_upstream_error' } })
    expect(response.body).not.toContain('segredo interno do provedor')
  })

  it('registra effort e model sem expor conteúdo da conversa', async () => {
    let logs = ''
    const logger = pino({ level: 'info', base: null }, new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logs += chunk.toString()
        callback()
      },
    }))
    codex.setHandler((_request, response) => sseResponse(response, 200, sse(responsesTextEvents('resposta pública'))))
    const response = await appFor({}, { logger }).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: {
        model: 'codex-cli-sol',
        messages: [{ role: 'user', content: 'PROMPT_ULTRASSECRETO' }],
        reasoning: { effort: 'max' },
      },
    })
    expect(response.statusCode).toBe(200)
    expect(logs).toContain('"model":"codex-cli-sol"')
    expect(logs).toContain('"effort":"xhigh"')
    expect(logs).not.toContain('PROMPT_ULTRASSECRETO')
  })

  it('envia prompt_cache_key estável ao Codex entre turnos da mesma conversa, sem vazar conteúdo', async () => {
    let logs = ''
    const logger = pino({ level: 'info', base: null }, new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logs += chunk.toString()
        callback()
      },
    }))
    codex.setHandler((_request, response) => sseResponse(response, 200, sse(responsesTextEvents('ok'))))
    const app = appFor({}, { logger })
    const conversa = [
      { role: 'system', content: 'agente' },
      { role: 'user', content: 'PROMPT_ULTRASSECRETO' },
    ]

    const primeiro = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'codex-cli-sol', messages: conversa },
    })
    const segundo = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: {
        model: 'codex-cli-sol',
        messages: [...conversa, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'continue' }],
      },
    })
    expect(primeiro.statusCode).toBe(200)
    expect(segundo.statusCode).toBe(200)

    const [turno1, turno2] = requestBodies(codex) as { prompt_cache_key?: string }[]
    expect(turno1?.prompt_cache_key).toMatch(/^azigate-[0-9a-f]{32}$/u)
    expect(turno2?.prompt_cache_key).toBe(turno1?.prompt_cache_key)
    expect(codex.requests.map((entry) => entry.body).join('')).not.toContain('azigate-undefined')

    // ADR-020 (adendo): o digest passa a ser registrado como `promptCacheKey` para
    // permitir correlacionar turnos da mesma conversa. O que continua proibido é o
    // conteúdo que originou o digest.
    expect(logs).toContain(`"promptCacheKey":"${turno1?.prompt_cache_key as string}"`)
    expect(logs).not.toContain('PROMPT_ULTRASSECRETO')
    expect(logs).toMatch(/"prefixFingerprint":"[0-9a-f]{16}"/u)
  })

  it('sempre pede SSE aos provedores CLI, mesmo quando o cliente não quer stream (regressão: 400 do backend Codex)', async () => {
    codex.setHandler((_request, response) => sseResponse(response, 200, sse(responsesTextEvents('pronto'))))
    claude.setHandler((_request, response) => sseResponse(response, 200, sse(anthropicTextEvents('pronto'))))
    const app = appFor({ enableClaudeCli: true })

    const codexResponse = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'codex-cli-sol', messages: [{ role: 'user', content: 'oi' }], stream: false },
    })
    expect(codexResponse.statusCode).toBe(200)
    expect(codexResponse.json()).toMatchObject({ object: 'chat.completion' })
    expect(requestBodies(codex)[0]).toMatchObject({ stream: true })
    expect(codex.requests[0]?.headers.accept).toBe('text/event-stream')

    const claudeResponse = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'claude-cli', messages: [{ role: 'user', content: 'oi' }], stream: false },
    })
    expect(claudeResponse.statusCode).toBe(200)
    expect(claudeResponse.json()).toMatchObject({ object: 'chat.completion' })
    expect(requestBodies(claude)[0]).toMatchObject({ stream: true })
    expect(claude.requests[0]?.headers.accept).toBe('text/event-stream')
  })

  it('registra usage do Codex também em streaming (regressão: telemetria só existia sem stream)', async () => {
    let logs = ''
    const logger = pino({ level: 'info', base: null }, new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logs += chunk.toString()
        callback()
      },
    }))
    codex.setHandler((_request, response) => sseResponse(response, 200, sse([
      { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.4', created_at: 1 } },
      { type: 'response.output_text.delta', delta: 'resposta pública' },
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 120,
            output_tokens: 30,
            total_tokens: 150,
            input_tokens_details: { cached_tokens: 90 },
            output_tokens_details: { reasoning_tokens: 12 },
          },
        },
      },
    ])))
    const app = appFor({}, { logger })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: CHAT_HEADERS,
      body: JSON.stringify({
        model: 'codex-cli-sol',
        messages: [{ role: 'user', content: 'PROMPT_ULTRASSECRETO' }],
        stream: true,
      }),
    })
    await response.text()
    await waitUntil(() => logs.includes('"path":"/v1/chat/completions"'))

    expect(logs).toContain('"stream":true')
    expect(logs).toContain('"inputTokens":120')
    expect(logs).toContain('"outputTokens":30')
    expect(logs).toContain('"totalTokens":150')
    expect(logs).toContain('"cachedInputTokens":90')
    expect(logs).toContain('"reasoningOutputTokens":12')
    expect(logs).toContain('"cacheHitPercent":75')
    expect(logs).not.toContain('PROMPT_ULTRASSECRETO')
    expect(logs).not.toContain('resposta pública')
  })

  describe('telemetria de cache do Codex (TOK-002/004/006/008)', () => {
    type LoggerDeTeste = NonNullable<AppDependencies['logger']>

    function capturaLogs(): { logger: LoggerDeTeste; linha: () => Record<string, unknown> } {
      let logs = ''
      const logger = pino({ level: 'info', base: null }, new Writable({
        write(chunk: Buffer, _encoding, callback) {
          logs += chunk.toString()
          callback()
        },
      }))
      const linha = (): Record<string, unknown> => {
        const bruto = logs
          .split('\n')
          .filter((entrada) => entrada.includes('/v1/chat/completions'))
          .pop()
        return JSON.parse(bruto ?? '{}') as Record<string, unknown>
      }
      return { logger, linha }
    }

    async function chamaCodex(
      logger: LoggerDeTeste,
      usage: Record<string, unknown> | undefined,
      payload: Record<string, unknown> = {},
    ): Promise<void> {
      codex.setHandler((_request, response) => sseResponse(response, 200, sse([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.4', created_at: 1 } },
        { type: 'response.output_text.delta', delta: 'ok' },
        { type: 'response.completed', response: usage === undefined ? {} : { usage } },
      ])))
      const app = appFor({}, { logger })
      const resposta = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: CHAT_HEADERS,
        payload: { model: 'codex-cli-sol', messages: [{ role: 'user', content: 'tarefa' }], ...payload },
      })
      expect(resposta.statusCode).toBe(200)
    }

    it('freshInputTokens é o input inteiro quando não há cache', async () => {
      const { logger, linha } = capturaLogs()
      await chamaCodex(logger, { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 } })
      expect(linha()).toMatchObject({ inputTokens: 100, cachedInputTokens: 0, freshInputTokens: 100, cacheHitPercent: 0 })
    })

    it('freshInputTokens desconta a parcela cacheada em cache parcial', async () => {
      const { logger, linha } = capturaLogs()
      await chamaCodex(logger, { input_tokens: 120, output_tokens: 30, total_tokens: 150, input_tokens_details: { cached_tokens: 90 } })
      expect(linha()).toMatchObject({ inputTokens: 120, cachedInputTokens: 90, freshInputTokens: 30, cacheHitPercent: 75 })
    })

    it('freshInputTokens é zero quando o cache cobre todo o input', async () => {
      const { logger, linha } = capturaLogs()
      await chamaCodex(logger, { input_tokens: 80, output_tokens: 5, total_tokens: 85, input_tokens_details: { cached_tokens: 80 } })
      expect(linha()).toMatchObject({ inputTokens: 80, cachedInputTokens: 80, freshInputTokens: 0, cacheHitPercent: 100 })
    })

    it('freshInputTokens usa o input total quando o provedor não informa cached_tokens', async () => {
      const { logger, linha } = capturaLogs()
      await chamaCodex(logger, { input_tokens: 42, output_tokens: 7, total_tokens: 49 })
      const registrada = linha()
      expect(registrada).toMatchObject({ inputTokens: 42, freshInputTokens: 42 })
      expect(registrada.cachedInputTokens).toBeUndefined()
      expect(registrada.cacheHitPercent).toBeUndefined()
    })

    it('nunca produz freshInputTokens negativo se o provedor reportar cache maior que o input', async () => {
      const { logger, linha } = capturaLogs()
      await chamaCodex(logger, { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 50 } })
      expect(linha()).toMatchObject({ freshInputTokens: 0 })
    })

    it('registra a forma do prompt junto do usage', async () => {
      const { logger, linha } = capturaLogs()
      await chamaCodex(logger, { input_tokens: 10, output_tokens: 1, total_tokens: 11 }, {
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
      })
      const registrada = linha()
      expect(registrada.usageObserved).toBe(true)
      expect(registrada.inputItemCount).toBe(1)
      expect(registrada.toolCount).toBe(1)
      expect(registrada.toolSchemaBytes as number).toBeGreaterThan(0)
      expect(registrada.requestBodyBytes as number).toBeGreaterThan(0)
      expect(registrada.retryCount).toBe(0)
      expect(registrada.promptCacheKey).toMatch(/^azigate-[0-9a-f]{32}$/u)
      expect(registrada.prefixFingerprint).toMatch(/^[0-9a-f]{16}$/u)
    })

    it('registra a forma do prompt mesmo sem usage, sem inventar tokens (TOK-006)', async () => {
      const { logger, linha } = capturaLogs()
      codex.setHandler((_request, response) => {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' })
        response.end(JSON.stringify({ error: 'rate_limited' }))
      })
      const app = appFor({}, { logger })
      const resposta = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: CHAT_HEADERS,
        payload: { model: 'codex-cli-sol', messages: [{ role: 'user', content: 'tarefa' }] },
      })
      expect(resposta.statusCode).toBe(429)

      const registrada = linha()
      expect(registrada.usageObserved).toBe(false)
      expect(registrada.inputTokens).toBeUndefined()
      expect(registrada.outputTokens).toBeUndefined()
      expect(registrada.freshInputTokens).toBeUndefined()
      expect(registrada.requestBodyBytes as number).toBeGreaterThan(0)
      expect(registrada.inputItemCount).toBe(1)
      expect(registrada.toolCount).toBe(0)
      expect(registrada.retryCount).toBe(0)
      expect(registrada.promptCacheKey).toMatch(/^azigate-[0-9a-f]{32}$/u)
      expect(registrada.prefixFingerprint).toMatch(/^[0-9a-f]{16}$/u)
    })

    it('propaga Retry-After do Codex para o cliente em 429 (TOK-008)', async () => {
      codex.setHandler((_request, response) => {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '42' })
        response.end(JSON.stringify({ error: 'rate_limited' }))
      })
      const app = appFor()
      const resposta = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: CHAT_HEADERS,
        payload: { model: 'codex-cli-sol', messages: [{ role: 'user', content: 'tarefa' }] },
      })

      expect(resposta.statusCode).toBe(429)
      expect(resposta.headers['retry-after']).toBe('42')
      expect(resposta.json()).toMatchObject({ error: { code: 'codex_upstream_error' } })
    })

    it('normaliza Retry-After em data HTTP para segundos inteiros', async () => {
      codex.setHandler((_request, response) => {
        response.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': new Date(Date.now() + 10_000).toUTCString(),
        })
        response.end(JSON.stringify({ error: 'rate_limited' }))
      })
      const app = appFor()
      const resposta = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: CHAT_HEADERS,
        payload: { model: 'codex-cli-sol', messages: [{ role: 'user', content: 'tarefa' }] },
      })

      expect(resposta.statusCode).toBe(429)
      expect(resposta.headers['retry-after']).toMatch(/^\d+$/u)
    })

    it('descarta Retry-After inválido em vez de repassar valor do fornecedor', async () => {
      codex.setHandler((_request, response) => {
        response.writeHead(503, { 'content-type': 'application/json', 'retry-after': 'não-é-um-número' })
        response.end(JSON.stringify({ error: 'unavailable' }))
      })
      const app = appFor()
      const resposta = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: CHAT_HEADERS,
        payload: { model: 'codex-cli-sol', messages: [{ role: 'user', content: 'tarefa' }] },
      })

      expect(resposta.statusCode).toBe(503)
      expect(resposta.headers['retry-after']).toBeUndefined()
    })
  })

  it('registra usage do Claude também em streaming', async () => {
    let logs = ''
    const logger = pino({ level: 'info', base: null }, new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logs += chunk.toString()
        callback()
      },
    }))
    claude.setHandler((_request, response) =>
      sseResponse(response, 200, sse(anthropicTextEvents('fluxo real', { input: 40, output: 7 }))))
    const app = appFor({ enableClaudeCli: true }, { logger })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: CHAT_HEADERS,
      body: JSON.stringify({ model: 'claude-cli', messages: [{ role: 'user', content: 'oi' }], stream: true }),
    })
    await response.text()
    await waitUntil(() => logs.includes('"path":"/v1/chat/completions"'))

    expect(logs).toContain('"stream":true')
    expect(logs).toContain('"inputTokens":40')
    expect(logs).toContain('"outputTokens":7')
  })

  it('combina catálogo DeepSeek com aliases CLI saudáveis (token OAuth presente)', async () => {
    deepseek.setHandler((_request, response) => jsonResponse(response, 200, {
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

  it('não publica alias habilitado sem token OAuth salvo (não logado)', async () => {
    deepseek.setHandler((_request, response) => jsonResponse(response, 200, { object: 'list', data: [] }))
    const response = await appFor({ codexTokenFile: join(secretsDir, 'nao-existe.json') }).inject({
      method: 'GET',
      url: '/v1/models',
      headers: AUTHORIZATION,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<{ data: { id: string }[] }>().data.map((model) => model.id)).toEqual([])
  })

  it('readiness aceita degradação da DeepSeek se um alias local estiver saudável', async () => {
    deepseek.setHandler((_request, response) => jsonResponse(response, 503, { error: 'indisponível' }))
    const ready = await appFor({ readyCheckUpstream: true }).inject({ method: 'GET', url: '/ready' })
    expect(ready.statusCode).toBe(200)

    const unavailable = await appFor({
      readyCheckUpstream: true,
      enableCodexCli: false,
      codexTokenFile: join(secretsDir, 'nao-existe.json'),
    }).inject({ method: 'GET', url: '/ready' })
    expect(unavailable.statusCode).toBe(503)
  })

  it('cancelamento do cliente encerra a conexão com o provedor sem propagar erro público', async () => {
    let providerRequestSeen = false
    claude.setHandler((_request, response) => {
      providerRequestSeen = true
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"claude-sonnet-4-6"}}\n\n')
      // nunca fecha o stream, força o cancelamento
    })
    const app = appFor({ enableClaudeCli: true })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as AddressInfo
    const abort = new AbortController()
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: CHAT_HEADERS,
      body: JSON.stringify({ model: 'claude-cli', messages: [{ role: 'user', content: 'oi' }], stream: true }),
      signal: abort.signal,
    })
    await (response.body as unknown as ReadableStream<Uint8Array>).getReader().read()
    abort.abort()
    await waitUntil(() => providerRequestSeen)
    expect(providerRequestSeen).toBe(true)
  })

  it('nunca faz fallback automático da DeepSeek quando o provedor CLI falha', async () => {
    codex.setHandler((_request, response) => jsonResponse(response, 503, { error: 'indisponível' }))
    const response = await appFor().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'codex-cli', messages: [] },
    })
    expect(response.statusCode).toBe(503)
    expect(deepseek.requests).toHaveLength(0)
  })

  it('registra métricas de streaming ativo sem expor conteúdo', async () => {
    const metrics = new GatewayMetrics()
    claude.setHandler((_request, response) => sseResponse(response, 200, sse(anthropicTextEvents('ok'))))
    const response = await appFor({ enableClaudeCli: true }, { metrics }).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: CHAT_HEADERS,
      payload: { model: 'claude-cli', messages: [{ role: 'user', content: 'oi' }], stream: true },
    })
    expect(response.statusCode).toBe(200)
    expect(metrics.snapshot().active_streams).toBe(0)
  })
})
