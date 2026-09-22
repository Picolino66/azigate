/**
 * Experimento manual da Fase 2 — AI-01: `store: true` + `previous_response_id`.
 *
 * NÃO faz parte da suíte automática (`vitest` só coleta `*.test.ts`) e NÃO é chamado
 * pelo fluxo `/v1/chat/completions`. Executa chamadas reais contra a Responses API do
 * Codex usando o token OAuth já presente em `CODEX_TOKEN_FILE`.
 *
 * Uso: npm run experiment:previous-response -- [cenário...]
 *
 * Invariante de privacidade: nenhum trecho de prompt, resposta ou tool argument é
 * impresso. O relatório carrega apenas contagens, digests, ids do fornecedor e
 * booleanos de verificação funcional.
 */
import { createHash } from 'node:crypto'
import type { ReadableStream } from 'node:stream/web'
import { CodexClient } from '../../src/providers/codex-client.js'
import { createTokenManager } from '../../src/providers/oauth/token-store.js'
import { refreshCodexToken } from '../../src/providers/oauth/codex-oauth.js'
import { readSseEvents } from '../../src/providers/sse-reader.js'

const MODEL = process.env.EXPERIMENT_MODEL?.trim() || 'gpt-5.6-terra'
const EFFORT = process.env.EXPERIMENT_EFFORT?.trim() || 'low'
const BASE_URL = process.env.CODEX_BASE_URL?.trim() || 'https://chatgpt.com/backend-api/codex'
const TOKEN_FILE = process.env.CODEX_TOKEN_FILE?.trim() || 'secrets/codex-oauth.json'
const SECRET_TOKEN = 'AZIGATE-7421'

interface InputMessage {
  type: 'message'
  role: 'developer' | 'user' | 'assistant'
  content: { type: 'input_text' | 'output_text'; text: string }[]
}
interface InputFunctionCallOutput {
  type: 'function_call_output'
  call_id: string
  output: string
}
type InputItem = InputMessage | InputFunctionCallOutput

interface ToolDefinition {
  type: 'function'
  name: string
  description?: string
  parameters: Record<string, unknown>
}

interface CallOptions {
  input: InputItem[]
  store: boolean
  previousResponseId?: string
  promptCacheKey?: string
  tools?: ToolDefinition[]
  abortAfterFirstDelta?: boolean
}

interface ObservedFunctionCall {
  callId: string
  name: string
  argumentsBytes: number
}

interface TurnResult {
  status: number
  responseId?: string
  previousResponseId: string | null
  requestBodyBytes: number
  inputItemCount: number
  inputTokens?: number | undefined
  cachedInputTokens?: number | undefined
  freshInputTokens?: number | undefined
  outputTokens?: number | undefined
  reasoningOutputTokens?: number | undefined
  durationMs: number
  outputTextLength: number
  recalledSecret: boolean
  functionCalls: ObservedFunctionCall[]
  errorSnippet?: string
  aborted?: boolean
}

function userMessage(text: string): InputMessage {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
}

function cacheKey(seed: string): string {
  return `azigate-exp-${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function numberAt(source: unknown, ...path: string[]): number | undefined {
  let cursor: unknown = source
  for (const key of path) {
    if (!isRecord(cursor)) return undefined
    cursor = cursor[key]
  }
  return typeof cursor === 'number' ? cursor : undefined
}

export class Experiment {
  private readonly client: CodexClient

  constructor() {
    this.client = new CodexClient(
      {
        baseUrl: BASE_URL,
        connectTimeoutMs: 30_000,
        requestTimeoutMs: 180_000,
        maxRetries: 0,
        retryMaxDelayMs: 2000,
      },
      createTokenManager({ provider: 'codex', filePath: TOKEN_FILE, refresh: refreshCodexToken }),
    )
  }

  async close(): Promise<void> {
    await this.client.close()
  }

  async call(options: CallOptions): Promise<TurnResult> {
    const body: Record<string, unknown> = {
      model: MODEL,
      instructions: '',
      store: options.store,
      stream: true,
      reasoning: { effort: EFFORT, summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      ...(options.promptCacheKey === undefined ? {} : { prompt_cache_key: options.promptCacheKey }),
      ...(options.previousResponseId === undefined ? {} : { previous_response_id: options.previousResponseId }),
      input: options.input,
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    }
    const serialized = JSON.stringify(body)
    const startedAt = Date.now()
    const controller = new AbortController()

    const result: TurnResult = {
      status: 0,
      previousResponseId: options.previousResponseId ?? null,
      requestBodyBytes: Buffer.byteLength(serialized),
      inputItemCount: options.input.length,
      durationMs: 0,
      outputTextLength: 0,
      recalledSecret: false,
      functionCalls: [],
    }

    let exchange
    try {
      exchange = await this.client.request({
        requestId: `exp-${Date.now().toString(36)}`,
        body: serialized,
        stream: true,
        signal: controller.signal,
      })
    } catch (error) {
      result.durationMs = Date.now() - startedAt
      result.errorSnippet = error instanceof Error ? error.name : 'erro desconhecido'
      return result
    }

    result.status = exchange.response.status

    if (!exchange.response.ok) {
      const raw = await exchange.response.text()
      // Corpo de erro do fornecedor: diagnóstico, nunca prompt. Truncado por segurança.
      result.errorSnippet = raw.replace(/\s+/gu, ' ').slice(0, 400)
      result.durationMs = Date.now() - startedAt
      exchange.dispose()
      return result
    }

    let text = ''
    const pendingArguments = new Map<number, { callId: string; name: string; args: string }>()

    try {
      const stream = exchange.response.body as unknown as ReadableStream<Uint8Array> | null
      if (!stream) throw new Error('sem corpo')
      for await (const event of readSseEvents(stream)) {
        let parsed: unknown
        try {
          parsed = JSON.parse(event.data)
        } catch {
          continue
        }
        if (!isRecord(parsed) || typeof parsed.type !== 'string') continue

        if (parsed.type === 'response.created' && isRecord(parsed.response)) {
          const id = parsed.response.id
          if (typeof id === 'string') result.responseId = id
        }

        if (parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
          text += parsed.delta
          if (options.abortAfterFirstDelta === true) {
            result.aborted = true
            controller.abort()
            break
          }
        }

        if (parsed.type === 'response.output_item.added' && isRecord(parsed.item)) {
          const item = parsed.item
          if (item.type === 'function_call' && typeof parsed.output_index === 'number') {
            pendingArguments.set(parsed.output_index, {
              callId: typeof item.call_id === 'string' ? item.call_id : '',
              name: typeof item.name === 'string' ? item.name : '',
              args: '',
            })
          }
        }

        if (parsed.type === 'response.function_call_arguments.done' && typeof parsed.output_index === 'number') {
          const tracked = pendingArguments.get(parsed.output_index)
          if (tracked) tracked.args = typeof parsed.arguments === 'string' ? parsed.arguments : ''
        }

        if (parsed.type === 'response.completed' || parsed.type === 'response.incomplete') {
          const usage = isRecord(parsed.response) ? parsed.response.usage : undefined
          result.inputTokens = numberAt(usage, 'input_tokens')
          result.cachedInputTokens = numberAt(usage, 'input_tokens_details', 'cached_tokens')
          result.outputTokens = numberAt(usage, 'output_tokens')
          result.reasoningOutputTokens = numberAt(usage, 'output_tokens_details', 'reasoning_tokens')
          if (result.inputTokens !== undefined) {
            result.freshInputTokens = Math.max(0, result.inputTokens - (result.cachedInputTokens ?? 0))
          }
        }

        if (parsed.type === 'response.failed' && isRecord(parsed.response)) {
          const error = parsed.response.error
          if (isRecord(error) && typeof error.message === 'string') {
            result.errorSnippet = error.message.slice(0, 400)
          }
        }
      }
    } catch (error) {
      if (result.aborted !== true) {
        result.errorSnippet = error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : 'erro de stream'
      }
    } finally {
      exchange.dispose()
    }

    result.functionCalls = [...pendingArguments.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({ callId: call.callId, name: call.name, argumentsBytes: Buffer.byteLength(call.args) }))
    result.outputTextLength = text.length
    result.recalledSecret = text.includes(SECRET_TOKEN)
    result.durationMs = Date.now() - startedAt
    return result
  }
}

export const ECHO_TOOL: ToolDefinition = {
  type: 'function',
  name: 'consultar_registro',
  description: 'Consulta um registro fictício pelo identificador.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Identificador do registro' } },
    required: ['id'],
    additionalProperties: false,
  },
}

export { userMessage, cacheKey, MODEL, EFFORT, SECRET_TOKEN }
export type { CallOptions, InputItem, ToolDefinition, TurnResult }
