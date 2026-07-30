import { baseChunk, originalToolName, roleDelta, trackToolCall, type OpenAiChunk, type OpenAiUsage, type StreamState, type TranslatedStreamStep } from './state.js'

export interface ResponsesUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

export type ResponsesStreamEvent =
  | { type: 'response.created'; response: { id: string; model: string; created_at: number } }
  | { type: 'response.output_text.delta'; delta: string }
  | { type: 'response.reasoning_summary_text.delta'; delta: string }
  | {
      type: 'response.output_item.added'
      output_index: number
      item: { type: string; id?: string; call_id?: string; name?: string }
    }
  | { type: 'response.function_call_arguments.delta'; output_index: number; delta: string }
  | { type: 'response.function_call_arguments.done'; output_index: number; arguments: string }
  | {
      type: 'response.output_item.done'
      output_index: number
      item: { type: string; call_id?: string; name?: string; arguments?: string }
    }
  | { type: 'response.completed'; response: { usage?: ResponsesUsage } }
  | { type: 'response.incomplete'; response: { usage?: ResponsesUsage; incomplete_details?: { reason?: string } } }

export type { OpenAiChunk, OpenAiChunkDelta, OpenAiUsage, TranslatedStreamStep } from './state.js'

const RESPONSES_EVENT_TYPES = new Set([
  'response.created',
  'response.output_text.delta',
  'response.reasoning_summary_text.delta',
  'response.output_item.added',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.output_item.done',
  'response.completed',
  'response.incomplete',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isResponsesStreamEvent(value: unknown): value is ResponsesStreamEvent {
  return isRecord(value) && typeof value.type === 'string' && RESPONSES_EVENT_TYPES.has(value.type)
}

function convertUsage(usage: ResponsesUsage | undefined): OpenAiUsage | undefined {
  if (!usage) return undefined
  const cachedTokens = usage.input_tokens_details?.cached_tokens
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens
  return {
    ...(usage.input_tokens === undefined ? {} : { prompt_tokens: usage.input_tokens }),
    ...(usage.output_tokens === undefined ? {} : { completion_tokens: usage.output_tokens }),
    ...(usage.total_tokens === undefined ? {} : { total_tokens: usage.total_tokens }),
    ...(cachedTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: cachedTokens } }),
    ...(reasoningTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: reasoningTokens } }),
  }
}

function finishReasonForIncomplete(reason: string | undefined): string {
  if (reason === 'max_output_tokens') return 'length'
  if (reason === 'content_filter') return 'content_filter'
  return 'stop'
}

export function translateResponsesEvent(event: ResponsesStreamEvent, state: StreamState): TranslatedStreamStep {
  switch (event.type) {
    case 'response.created': {
      state.id = event.response.id
      state.model = event.response.model
      return { chunks: [], done: false }
    }

    case 'response.output_text.delta': {
      const role = roleDelta(state)
      return { chunks: [baseChunk(state, { ...role, content: event.delta })], done: false }
    }

    case 'response.reasoning_summary_text.delta': {
      const role = roleDelta(state)
      return { chunks: [baseChunk(state, { ...role, reasoning_content: event.delta })], done: false }
    }

    case 'response.output_item.added': {
      if (event.item.type !== 'function_call') return { chunks: [], done: false }
      const track = trackToolCall(state, String(event.output_index))
      const role = roleDelta(state)
      const name = event.item.name === undefined ? undefined : originalToolName(state, event.item.name)
      return {
        chunks: [
          baseChunk(state, {
            ...role,
            tool_calls: [
              {
                index: track.openAiIndex,
                ...(event.item.call_id === undefined ? {} : { id: event.item.call_id }),
                type: 'function',
                function: { ...(name === undefined ? {} : { name }), arguments: '' },
              },
            ],
          }),
        ],
        done: false,
      }
    }

    case 'response.function_call_arguments.delta': {
      const track = trackToolCall(state, String(event.output_index))
      track.argumentsDeltaSeen = true
      return {
        chunks: [baseChunk(state, { tool_calls: [{ index: track.openAiIndex, function: { arguments: event.delta } }] })],
        done: false,
      }
    }

    case 'response.function_call_arguments.done': {
      const track = trackToolCall(state, String(event.output_index))
      if (track.argumentsDeltaSeen) return { chunks: [], done: false }
      return {
        chunks: [
          baseChunk(state, { tool_calls: [{ index: track.openAiIndex, function: { arguments: event.arguments } }] }),
        ],
        done: false,
      }
    }

    case 'response.output_item.done': {
      if (event.item.type !== 'function_call') return { chunks: [], done: false }
      const key = String(event.output_index)
      if (state.toolCallsByKey.has(key)) return { chunks: [], done: false }
      const track = trackToolCall(state, key)
      const role = roleDelta(state)
      const name = event.item.name === undefined ? undefined : originalToolName(state, event.item.name)
      return {
        chunks: [
          baseChunk(state, {
            ...role,
            tool_calls: [
              {
                index: track.openAiIndex,
                ...(event.item.call_id === undefined ? {} : { id: event.item.call_id }),
                type: 'function',
                function: { ...(name === undefined ? {} : { name }), arguments: event.item.arguments ?? '' },
              },
            ],
          }),
        ],
        done: false,
      }
    }

    case 'response.completed': {
      const finishReason = state.toolCallSeen ? 'tool_calls' : 'stop'
      const chunks: OpenAiChunk[] = [baseChunk(state, {}, finishReason)]
      const usage = convertUsage(event.response.usage)
      if (usage) chunks.push({ ...baseChunk(state, {}), choices: [], usage })
      return { chunks, done: true }
    }

    case 'response.incomplete': {
      const finishReason = finishReasonForIncomplete(event.response.incomplete_details?.reason)
      const chunks: OpenAiChunk[] = [baseChunk(state, {}, finishReason)]
      const usage = convertUsage(event.response.usage)
      if (usage) chunks.push({ ...baseChunk(state, {}), choices: [], usage })
      return { chunks, done: true }
    }
  }
}
