import { createHash } from 'node:crypto'
import type { ChatBody } from '../types.js'
import type { ShortNameMapping } from './state.js'

export type ResponsesContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'input_file'; file_data: string; filename?: string }
  | { type: 'input_audio'; data: string; format: string }

export interface ResponsesMessageItem {
  type: 'message'
  role: 'developer' | 'user' | 'assistant'
  content: ResponsesContentPart[]
}

export interface ResponsesFunctionCallItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
}

export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string
}

export type ResponsesInputItem = ResponsesMessageItem | ResponsesFunctionCallItem | ResponsesFunctionCallOutputItem

export interface ResponsesTool {
  type: 'function'
  name: string
  description?: string
  parameters: Record<string, unknown>
  strict?: boolean
}

export type ResponsesToolChoice = 'auto' | 'required' | 'none' | { type: 'function'; name: string }

export interface ResponsesTextFormat {
  type: string
  name?: string
  strict?: boolean
  schema?: Record<string, unknown>
}

export interface ResponsesRequestBody {
  model: string
  instructions: ''
  store: false
  stream: true
  parallel_tool_calls?: boolean
  reasoning: { effort: string; summary: 'auto' }
  include: ['reasoning.encrypted_content']
  prompt_cache_key?: string
  input: ResponsesInputItem[]
  tools?: ResponsesTool[]
  tool_choice?: ResponsesToolChoice
  text?: { format: ResponsesTextFormat }
}

export interface OpenAiToResponsesOptions {
  model: string
  effort?: string
}

export interface TranslatedResponsesRequest {
  request: ResponsesRequestBody
  shortNames: ShortNameMapping
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const MAX_TOOL_NAME_LENGTH = 64

export function buildShortNameMap(names: readonly string[]): ShortNameMapping {
  const shortToOriginal = new Map<string, string>()
  const originalToShort = new Map<string, string>()
  const used = new Set<string>(names.filter((name) => name.length <= MAX_TOOL_NAME_LENGTH))

  for (const name of names) {
    if (name.length <= MAX_TOOL_NAME_LENGTH) continue
    const prefix = name.startsWith('mcp__') ? 'mcp__' : ''
    const rest = prefix ? name.slice(prefix.length) : name
    const lastSeparator = rest.lastIndexOf('__')
    const lastSegment = lastSeparator >= 0 ? rest.slice(lastSeparator + 2) : rest
    const separator = '__'
    const budget = MAX_TOOL_NAME_LENGTH - prefix.length - separator.length - lastSegment.length
    const head = budget > 0 ? rest.slice(0, budget) : ''
    let candidate = budget > 0 ? `${prefix}${head}${separator}${lastSegment}` : `${prefix}${lastSegment}`.slice(0, MAX_TOOL_NAME_LENGTH)

    let suffix = 2
    while (used.has(candidate)) {
      const suffixText = `_${String(suffix)}`
      candidate = `${candidate.slice(0, MAX_TOOL_NAME_LENGTH - suffixText.length)}${suffixText}`
      suffix += 1
    }

    used.add(candidate)
    shortToOriginal.set(candidate, name)
    originalToShort.set(name, candidate)
  }

  return { shortToOriginal, originalToShort }
}

function extractPlainText(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('')
  }
  return ''
}

function convertUserOrAssistantContent(
  content: unknown,
  textType: 'input_text' | 'output_text',
): ResponsesContentPart[] {
  if (typeof content === 'string') return [{ type: textType, text: content }]
  if (!Array.isArray(content)) return []
  return content.flatMap((part): ResponsesContentPart[] => {
    if (!isRecord(part)) return []
    if (part.type === 'text' && typeof part.text === 'string') return [{ type: textType, text: part.text }]
    if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
      return [{ type: 'input_image', image_url: part.image_url.url }]
    }
    if (part.type === 'file' && isRecord(part.file) && typeof part.file.file_data === 'string') {
      const filename = typeof part.file.filename === 'string' ? part.file.filename : undefined
      return [{ type: 'input_file', file_data: part.file.file_data, ...(filename === undefined ? {} : { filename }) }]
    }
    if (part.type === 'input_audio' && isRecord(part.input_audio) && typeof part.input_audio.data === 'string') {
      const format = typeof part.input_audio.format === 'string' ? part.input_audio.format : 'wav'
      return [{ type: 'input_audio', data: part.input_audio.data, format }]
    }
    return []
  })
}

function convertMessages(messages: unknown[], shortNames: ShortNameMapping): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = []

  for (const raw of messages) {
    if (!isRecord(raw)) continue
    const role = raw.role

    if (role === 'system') {
      const content = convertUserOrAssistantContent(raw.content, 'input_text')
      if (content.length > 0) items.push({ type: 'message', role: 'developer', content })
      continue
    }

    if (role === 'user') {
      const content = convertUserOrAssistantContent(raw.content, 'input_text')
      items.push({ type: 'message', role: 'user', content })
      continue
    }

    if (role === 'assistant') {
      const content = convertUserOrAssistantContent(raw.content, 'output_text')
      if (content.length > 0) items.push({ type: 'message', role: 'assistant', content })

      const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : []
      for (const rawCall of toolCalls) {
        if (!isRecord(rawCall) || !isRecord(rawCall.function) || typeof rawCall.id !== 'string') continue
        const originalName = typeof rawCall.function.name === 'string' ? rawCall.function.name : ''
        const name = shortNames.originalToShort.get(originalName) ?? originalName
        const args = typeof rawCall.function.arguments === 'string' ? rawCall.function.arguments : '{}'
        items.push({ type: 'function_call', call_id: rawCall.id, name, arguments: args })
      }
      continue
    }

    if (role === 'tool') {
      const callId = typeof raw.tool_call_id === 'string' ? raw.tool_call_id : ''
      items.push({ type: 'function_call_output', call_id: callId, output: extractPlainText(raw.content) })
    }
  }

  return items
}

const CACHE_KEY_PREFIX = 'azigate'
const CACHE_KEY_HEX_LENGTH = 32

// Âncora estável da conversa: o primeiro texto de usuário não vazio. Ele não muda
// entre turnos e separa conversas distintas. Mensagens `system` ficam de fora de
// propósito: agentes costumam injetar conteúdo volátil nelas (data, cwd, arquivos
// abertos), o que rotacionaria a chave a cada turno e anularia o roteamento.
function conversationAnchor(messages: readonly unknown[]): string | undefined {
  for (const raw of messages) {
    if (!isRecord(raw) || raw.role !== 'user') continue
    const text = extractPlainText(raw.content)
    if (text.length > 0) return text
  }
  return undefined
}

// Deriva um identificador opaco de roteamento de cache. Só o digest sai do
// processo: nenhum trecho da conversa é enviado ou registrado por esta função.
export function buildPromptCacheKey(anchor: string, toolNames: readonly string[]): string {
  const hash = createHash('sha256')
  hash.update(`${String(toolNames.length)}\n`)
  for (const name of toolNames) hash.update(`${name}\n`)
  hash.update('\u0000')
  hash.update(anchor)
  return `${CACHE_KEY_PREFIX}-${hash.digest('hex').slice(0, CACHE_KEY_HEX_LENGTH)}`
}

function convertTools(tools: unknown, shortNames: ShortNameMapping): ResponsesTool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool) => {
    const fn = isRecord(tool) && isRecord(tool.function) ? tool.function : {}
    const originalName = typeof fn.name === 'string' ? fn.name : ''
    const name = shortNames.originalToShort.get(originalName) ?? originalName
    const description = typeof fn.description === 'string' ? fn.description : undefined
    const parameters = isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} }
    const strict = typeof fn.strict === 'boolean' ? fn.strict : undefined
    return {
      type: 'function' as const,
      name,
      ...(description === undefined ? {} : { description }),
      parameters,
      ...(strict === undefined ? {} : { strict }),
    }
  })
}

function convertToolChoice(toolChoice: unknown, shortNames: ShortNameMapping): ResponsesToolChoice | undefined {
  if (toolChoice === undefined) return undefined
  if (toolChoice === 'auto' || toolChoice === 'required' || toolChoice === 'none') return toolChoice
  if (
    isRecord(toolChoice) &&
    toolChoice.type === 'function' &&
    isRecord(toolChoice.function) &&
    typeof toolChoice.function.name === 'string'
  ) {
    const name = shortNames.originalToShort.get(toolChoice.function.name) ?? toolChoice.function.name
    return { type: 'function', name }
  }
  return undefined
}

function convertTextFormat(responseFormat: unknown): { format: ResponsesTextFormat } | undefined {
  if (!isRecord(responseFormat) || responseFormat.type !== 'json_schema' || !isRecord(responseFormat.json_schema)) {
    return undefined
  }
  const jsonSchema = responseFormat.json_schema
  const name = typeof jsonSchema.name === 'string' ? jsonSchema.name : undefined
  const strict = typeof jsonSchema.strict === 'boolean' ? jsonSchema.strict : undefined
  const schema = isRecord(jsonSchema.schema) ? jsonSchema.schema : undefined
  return {
    format: {
      type: 'json_schema',
      ...(name === undefined ? {} : { name }),
      ...(strict === undefined ? {} : { strict }),
      ...(schema === undefined ? {} : { schema }),
    },
  }
}

export function translateOpenAiToResponses(body: ChatBody, options: OpenAiToResponsesOptions): TranslatedResponsesRequest {
  const toolNames = Array.isArray(body.tools)
    ? body.tools
        .map((tool) => (isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === 'string' ? tool.function.name : undefined))
        .filter((name): name is string => name !== undefined)
    : []
  const shortNames = buildShortNameMap(toolNames)

  const anchor = conversationAnchor(body.messages)
  const promptCacheKey = anchor === undefined ? undefined : buildPromptCacheKey(anchor, toolNames)

  const input = convertMessages(body.messages, shortNames)
  const tools = convertTools(body.tools, shortNames)
  const toolChoice = convertToolChoice(body.tool_choice, shortNames)
  const textFormat = convertTextFormat(body.response_format)
  const parallelToolCalls = typeof body.parallel_tool_calls === 'boolean' ? body.parallel_tool_calls : undefined

  const request: ResponsesRequestBody = {
    model: options.model,
    instructions: '',
    store: false,
    stream: true,
    ...(tools !== undefined && parallelToolCalls !== undefined ? { parallel_tool_calls: parallelToolCalls } : {}),
    reasoning: { effort: options.effort ?? 'medium', summary: 'auto' },
    include: ['reasoning.encrypted_content'],
    ...(promptCacheKey === undefined ? {} : { prompt_cache_key: promptCacheKey }),
    input,
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(textFormat === undefined ? {} : { text: textFormat }),
  }

  return { request, shortNames }
}
