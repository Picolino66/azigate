import { baseChunk, roleDelta, trackToolCall, type OpenAiChunk, type OpenAiUsage, type StreamState, type TranslatedStreamStep } from './state.js'

export type AnthropicStopReason = string

export type AnthropicStreamEvent =
  | { type: 'message_start'; message: { id: string; model: string; usage?: { input_tokens?: number } } }
  | { type: 'content_block_start'; index: number; content_block: { type: 'text' } | { type: 'thinking' } | { type: 'tool_use'; id: string; name: string } }
  | {
      type: 'content_block_delta'
      index: number
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'input_json_delta'; partial_json: string }
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason?: AnthropicStopReason | null }; usage?: { output_tokens?: number } }
  | { type: 'message_stop' }
  | { type: 'error'; error: { message?: string; type?: string } }

export type { OpenAiChunk, OpenAiChunkDelta, OpenAiUsage, TranslatedStreamStep } from './state.js'

const ANTHROPIC_EVENT_TYPES = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
  'error',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isAnthropicStreamEvent(value: unknown): value is AnthropicStreamEvent {
  return isRecord(value) && typeof value.type === 'string' && ANTHROPIC_EVENT_TYPES.has(value.type)
}

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  stop_sequence: 'stop',
  refusal: 'content_filter',
}

function mapStopReason(reason: string | null | undefined): string {
  if (reason === null || reason === undefined) return 'stop'
  return STOP_REASON_MAP[reason] ?? 'stop'
}

export function translateAnthropicEvent(event: AnthropicStreamEvent, state: StreamState): TranslatedStreamStep {
  switch (event.type) {
    case 'message_start': {
      state.id = event.message.id
      state.model = event.message.model
      if (event.message.usage?.input_tokens !== undefined) state.inputTokens = event.message.usage.input_tokens
      return { chunks: [], done: false }
    }

    case 'content_block_start': {
      if (event.content_block.type === 'tool_use') {
        const track = trackToolCall(state, String(event.index))
        const role = roleDelta(state)
        return {
          chunks: [
            baseChunk(state, {
              ...role,
              tool_calls: [
                {
                  index: track.openAiIndex,
                  id: event.content_block.id,
                  type: 'function',
                  function: { name: event.content_block.name, arguments: '' },
                },
              ],
            }),
          ],
          done: false,
        }
      }
      if (event.content_block.type === 'text') {
        const role = roleDelta(state)
        if (!role) return { chunks: [], done: false }
        return { chunks: [baseChunk(state, role)], done: false }
      }
      return { chunks: [], done: false }
    }

    case 'content_block_delta': {
      if (event.delta.type === 'text_delta') {
        return { chunks: [baseChunk(state, { content: event.delta.text })], done: false }
      }
      if (event.delta.type === 'thinking_delta') {
        return { chunks: [baseChunk(state, { reasoning_content: event.delta.thinking })], done: false }
      }
      const track = trackToolCall(state, String(event.index))
      return {
        chunks: [
          baseChunk(state, {
            tool_calls: [{ index: track.openAiIndex, function: { arguments: event.delta.partial_json } }],
          }),
        ],
        done: false,
      }
    }

    case 'content_block_stop':
      return { chunks: [], done: false }

    case 'message_delta': {
      const chunks: OpenAiChunk[] = []
      if (event.delta.stop_reason !== undefined && event.delta.stop_reason !== null) {
        chunks.push(baseChunk(state, {}, mapStopReason(event.delta.stop_reason)))
      }
      if (event.usage?.output_tokens !== undefined) {
        const usage: OpenAiUsage = {
          ...(state.inputTokens === undefined ? {} : { prompt_tokens: state.inputTokens }),
          completion_tokens: event.usage.output_tokens,
          total_tokens: (state.inputTokens ?? 0) + event.usage.output_tokens,
        }
        chunks.push({ ...baseChunk(state, {}), choices: [], usage })
      }
      return { chunks, done: false }
    }

    case 'message_stop':
      return { chunks: [], done: true }

    case 'error':
      return { chunks: [], done: true, errored: true }
  }
}
