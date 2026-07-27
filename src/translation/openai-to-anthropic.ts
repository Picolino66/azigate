import { randomBytes } from 'node:crypto'
import type { ChatBody } from '../types.js'

export interface AnthropicTextBlock {
  type: 'text'
  text: string
}

export interface AnthropicImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string }
}

export interface AnthropicDocumentBlock {
  type: 'document'
  source: { type: 'base64'; media_type: string; data: string }
}

export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export type AnthropicToolEntry = AnthropicTool | Record<string, unknown>

export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'none' }
  | { type: 'tool'; name: string }

export type AnthropicThinking = { type: 'adaptive' } | { type: 'enabled'; budget_tokens: number }

export interface AnthropicRequestBody {
  model: string
  messages: AnthropicMessage[]
  max_tokens: number
  system?: AnthropicTextBlock[]
  stream?: boolean
  top_p?: number
  temperature?: number
  stop_sequences?: string[]
  tools?: AnthropicToolEntry[]
  tool_choice?: AnthropicToolChoice
  thinking?: AnthropicThinking
  output_config?: { effort: string }
}

export type CliEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface OpenAiToAnthropicOptions {
  model: string
  defaultMaxTokens: number
  effort?: CliEffortLevel
  thinkingBudgetTokens?: Readonly<Record<CliEffortLevel, number>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const DATA_URL = /^data:([^;]+);base64,([\s\S]+)$/u
const TOOL_USE_ID = /^[A-Za-z0-9_-]+$/u

function sanitizeToolUseId(id: unknown): string {
  if (typeof id === 'string' && id.length > 0 && TOOL_USE_ID.test(id)) return id
  return `toolu_${randomBytes(12).toString('hex')}`
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
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

function imageBlockFromUrl(url: string): AnthropicImageBlock {
  const match = DATA_URL.exec(url)
  if (match) {
    const mediaType = match[1] ?? 'application/octet-stream'
    const data = match[2] ?? ''
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
  }
  return { type: 'image', source: { type: 'url', url } }
}

function documentBlockFromFileData(fileData: string): AnthropicDocumentBlock | undefined {
  const match = DATA_URL.exec(fileData)
  if (!match) return undefined
  const mediaType = match[1] ?? 'application/octet-stream'
  const data = match[2] ?? ''
  return { type: 'document', source: { type: 'base64', media_type: mediaType, data } }
}

function convertContentPart(part: unknown): AnthropicContentBlock[] {
  if (!isRecord(part)) return []
  if (part.type === 'text' && typeof part.text === 'string') {
    return [{ type: 'text', text: part.text }]
  }
  if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
    return [imageBlockFromUrl(part.image_url.url)]
  }
  if (part.type === 'file' && isRecord(part.file) && typeof part.file.file_data === 'string') {
    const block = documentBlockFromFileData(part.file.file_data)
    return block ? [block] : []
  }
  return []
}

function convertUserContent(content: unknown): AnthropicContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return [{ type: 'text', text: '' }]
  const blocks = content.flatMap((part) => convertContentPart(part))
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
}

function convertAssistantContent(
  message: Record<string, unknown>,
  toolCallIdMap: Map<string, string>,
): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = []
  const text = extractPlainText(message.content)
  if (text.length > 0) blocks.push({ type: 'text', text })
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  for (const rawCall of toolCalls) {
    if (!isRecord(rawCall) || !isRecord(rawCall.function)) continue
    const anthropicId = sanitizeToolUseId(rawCall.id)
    if (typeof rawCall.id === 'string') toolCallIdMap.set(rawCall.id, anthropicId)
    const name = typeof rawCall.function.name === 'string' ? rawCall.function.name : ''
    blocks.push({
      type: 'tool_use',
      id: anthropicId,
      name,
      input: parseToolArguments(rawCall.function.arguments),
    })
  }
  return blocks
}

function toolResultBlock(
  message: Record<string, unknown>,
  toolCallIdMap: Map<string, string>,
): AnthropicToolResultBlock {
  const originalId = message.tool_call_id
  const mapped = typeof originalId === 'string' ? toolCallIdMap.get(originalId) : undefined
  const toolUseId = mapped ?? sanitizeToolUseId(originalId)
  return { type: 'tool_result', tool_use_id: toolUseId, content: extractPlainText(message.content) }
}

function convertMessages(messages: unknown[]): { system: AnthropicTextBlock[]; messages: AnthropicMessage[] } {
  const system: AnthropicTextBlock[] = []
  const result: AnthropicMessage[] = []
  const toolCallIdMap = new Map<string, string>()
  let pendingToolResults: AnthropicToolResultBlock[] = []

  const flushToolResults = (): void => {
    if (pendingToolResults.length > 0) result.push({ role: 'user', content: pendingToolResults })
    pendingToolResults = []
  }

  for (const raw of messages) {
    if (!isRecord(raw)) continue
    const role = raw.role
    if (role === 'system' || role === 'developer') {
      flushToolResults()
      const text = extractPlainText(raw.content)
      if (text.length > 0) system.push({ type: 'text', text })
      continue
    }
    if (role === 'tool') {
      pendingToolResults = [...pendingToolResults, toolResultBlock(raw, toolCallIdMap)]
      continue
    }
    flushToolResults()
    if (role === 'user') {
      result.push({ role: 'user', content: convertUserContent(raw.content) })
    } else if (role === 'assistant') {
      const content = convertAssistantContent(raw, toolCallIdMap)
      if (content.length > 0) result.push({ role: 'assistant', content })
    }
  }
  flushToolResults()
  return { system, messages: result }
}

const EMPTY_ARRAY_KEYS_TO_DROP = ['allowed_domains', 'blocked_domains']

function sanitizeOpaqueTool(tool: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...tool }
  for (const key of EMPTY_ARRAY_KEYS_TO_DROP) {
    if (Array.isArray(clone[key]) && clone[key].length === 0) delete clone[key]
  }
  return clone
}

function convertTools(tools: unknown): AnthropicToolEntry[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool) => {
    if (isRecord(tool) && tool.type === 'function' && isRecord(tool.function)) {
      const fn = tool.function
      const name = typeof fn.name === 'string' ? fn.name : ''
      const description = typeof fn.description === 'string' ? fn.description : undefined
      const parameters = isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} }
      return {
        name,
        ...(description === undefined ? {} : { description }),
        input_schema: parameters,
      }
    }
    return isRecord(tool) ? sanitizeOpaqueTool(tool) : {}
  })
}

function convertToolChoice(toolChoice: unknown): AnthropicToolChoice | undefined {
  if (toolChoice === undefined) return undefined
  if (toolChoice === 'auto') return { type: 'auto' }
  if (toolChoice === 'required') return { type: 'any' }
  if (toolChoice === 'none') return { type: 'none' }
  if (
    isRecord(toolChoice) &&
    toolChoice.type === 'function' &&
    isRecord(toolChoice.function) &&
    typeof toolChoice.function.name === 'string'
  ) {
    return { type: 'tool', name: toolChoice.function.name }
  }
  return undefined
}

function convertStop(stop: unknown): string[] | undefined {
  if (typeof stop === 'string') return [stop]
  if (Array.isArray(stop)) {
    const values = stop.filter((value): value is string => typeof value === 'string')
    return values.length > 0 ? values : undefined
  }
  return undefined
}

function convertThinking(
  effort: CliEffortLevel | undefined,
  budgetTable: Readonly<Record<CliEffortLevel, number>> | undefined,
): { thinking?: AnthropicThinking; output_config?: { effort: string } } {
  if (effort === undefined) return {}
  if (budgetTable) return { thinking: { type: 'enabled', budget_tokens: budgetTable[effort] } }
  return { thinking: { type: 'adaptive' }, output_config: { effort } }
}

export function translateOpenAiToAnthropic(body: ChatBody, options: OpenAiToAnthropicOptions): AnthropicRequestBody {
  const { system, messages } = convertMessages(body.messages)
  const nonEmptyMessages = messages.length > 0 ? messages : [{ role: 'user' as const, content: [{ type: 'text' as const, text: '' }] }]

  const maxTokens =
    typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens) && body.max_tokens > 0
      ? body.max_tokens
      : options.defaultMaxTokens

  const { thinking, output_config } = convertThinking(options.effort, options.thinkingBudgetTokens)
  const tools = convertTools(body.tools)
  const toolChoice = convertToolChoice(body.tool_choice)
  const stopSequences = convertStop(body.stop)
  const topP = typeof body.top_p === 'number' ? body.top_p : undefined
  const temperature = typeof body.temperature === 'number' ? body.temperature : undefined
  const dropSamplingParams = thinking !== undefined

  return {
    model: options.model,
    messages: nonEmptyMessages,
    max_tokens: maxTokens,
    ...(system.length > 0 ? { system } : {}),
    ...(body.stream === undefined ? {} : { stream: body.stream }),
    ...(!dropSamplingParams && topP !== undefined ? { top_p: topP } : {}),
    ...(!dropSamplingParams && temperature !== undefined ? { temperature } : {}),
    ...(stopSequences === undefined ? {} : { stop_sequences: stopSequences }),
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(output_config === undefined ? {} : { output_config }),
  }
}
