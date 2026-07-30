export interface ToolCallTrack {
  openAiIndex: number
  argumentsDeltaSeen: boolean
}

export interface ShortNameMapping {
  shortToOriginal: ReadonlyMap<string, string>
  originalToShort: ReadonlyMap<string, string>
}

export interface StreamState {
  id: string
  model: string
  createdAt: number
  roleEmitted: boolean
  nextToolCallIndex: number
  toolCallsByKey: Map<string, ToolCallTrack>
  toolCallSeen: boolean
  inputTokens?: number
  shortNameMap?: ShortNameMapping
}

export function createStreamState(
  model: string,
  id: string,
  createdAt: number = Math.floor(Date.now() / 1000),
  shortNameMap?: ShortNameMapping,
): StreamState {
  return {
    id,
    model,
    createdAt,
    roleEmitted: false,
    nextToolCallIndex: 0,
    toolCallsByKey: new Map(),
    toolCallSeen: false,
    ...(shortNameMap === undefined ? {} : { shortNameMap }),
  }
}

export function trackToolCall(state: StreamState, key: string): ToolCallTrack {
  const existing = state.toolCallsByKey.get(key)
  if (existing) return existing
  const created: ToolCallTrack = { openAiIndex: state.nextToolCallIndex, argumentsDeltaSeen: false }
  state.toolCallsByKey.set(key, created)
  state.nextToolCallIndex += 1
  state.toolCallSeen = true
  return created
}

export function originalToolName(state: StreamState, name: string): string {
  return state.shortNameMap?.shortToOriginal.get(name) ?? name
}

export interface OpenAiChunkDelta {
  role?: 'assistant'
  content?: string
  reasoning_content?: string
  tool_calls?: Array<{
    index: number
    id?: string
    type?: 'function'
    function?: { name?: string; arguments?: string }
  }>
}

export interface OpenAiUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

export interface OpenAiChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{ index: number; delta: OpenAiChunkDelta; finish_reason: string | null }>
  usage?: OpenAiUsage
}

export interface TranslatedStreamStep {
  chunks: OpenAiChunk[]
  done: boolean
  errored?: boolean
}

export function baseChunk(state: StreamState, delta: OpenAiChunkDelta, finishReason: string | null = null): OpenAiChunk {
  return {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.createdAt,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

export function roleDelta(state: StreamState): OpenAiChunkDelta | undefined {
  if (state.roleEmitted) return undefined
  state.roleEmitted = true
  return { role: 'assistant' }
}
