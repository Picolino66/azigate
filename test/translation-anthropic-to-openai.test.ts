import { describe, expect, it } from 'vitest'
import { createStreamState } from '../src/translation/state.js'
import { translateAnthropicEvent, type AnthropicStreamEvent } from '../src/translation/anthropic-to-openai.js'

function run(events: AnthropicStreamEvent[]) {
  const state = createStreamState('placeholder', 'placeholder', 1_700_000_000)
  return events.flatMap((event) => translateAnthropicEvent(event, state).chunks)
}

describe('anthropic-to-openai', () => {
  it('message_start captura id/model/usage e não emite chunk', () => {
    const state = createStreamState('placeholder', 'placeholder', 1_700_000_000)
    const step = translateAnthropicEvent(
      { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 10 } } },
      state,
    )
    expect(step).toEqual({ chunks: [], done: false })
    expect(state.id).toBe('msg_1')
    expect(state.model).toBe('claude-sonnet-4-6')
    expect(state.inputTokens).toBe(10)
  })

  it('content_block_start de texto emite delta.role uma única vez', () => {
    const chunks = run([
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'oi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    ])
    const roleChunks = chunks.filter((chunk) => chunk.choices[0]?.delta.role === 'assistant')
    expect(roleChunks).toHaveLength(1)
  })

  it('content_block_start tool_use abre índice e emite delta.tool_calls', () => {
    const state = createStreamState('m', 'id', 1)
    const step = translateAnthropicEvent(
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_abc', name: 'read_file' } },
      state,
    )
    expect(step.chunks[0]?.choices[0]?.delta).toEqual({
      role: 'assistant',
      tool_calls: [{ index: 0, id: 'toolu_abc', type: 'function', function: { name: 'read_file', arguments: '' } }],
    })
  })

  it('input_json_delta emite delta.tool_calls com arguments parciais no índice correto', () => {
    const state = createStreamState('m', 'id', 1)
    translateAnthropicEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'x' } }, state)
    const step = translateAnthropicEvent(
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
      state,
    )
    expect(step.chunks[0]?.choices[0]?.delta.tool_calls).toEqual([{ index: 0, function: { arguments: '{"a":' } }])
  })

  it('thinking_delta emite delta.reasoning_content', () => {
    const state = createStreamState('m', 'id', 1)
    const step = translateAnthropicEvent(
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pensando...' } },
      state,
    )
    expect(step.chunks[0]?.choices[0]?.delta.reasoning_content).toBe('pensando...')
  })

  it('content_block_start de thinking não emite chunk', () => {
    const state = createStreamState('m', 'id', 1)
    const step = translateAnthropicEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }, state)
    expect(step).toEqual({ chunks: [], done: false })
  })

  it('content_block_stop não emite chunk', () => {
    const state = createStreamState('m', 'id', 1)
    expect(translateAnthropicEvent({ type: 'content_block_stop', index: 0 }, state)).toEqual({ chunks: [], done: false })
  })

  it.each([
    ['end_turn', 'stop'],
    ['max_tokens', 'length'],
    ['tool_use', 'tool_calls'],
    ['stop_sequence', 'stop'],
    ['refusal', 'content_filter'],
    ['algo_desconhecido', 'stop'],
  ])('message_delta mapeia stop_reason %s para finish_reason %s', (stopReason, finishReason) => {
    const state = createStreamState('m', 'id', 1)
    const step = translateAnthropicEvent({ type: 'message_delta', delta: { stop_reason: stopReason } }, state)
    expect(step.chunks[0]?.choices[0]?.finish_reason).toBe(finishReason)
  })

  it('message_delta com usage emite chunk de usage com prompt/completion/total tokens', () => {
    const state = createStreamState('m', 'id', 1)
    state.inputTokens = 100
    const step = translateAnthropicEvent({ type: 'message_delta', delta: {}, usage: { output_tokens: 50 } }, state)
    const usageChunk = step.chunks.find((chunk) => chunk.usage !== undefined)
    expect(usageChunk?.usage).toEqual({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 })
    expect(usageChunk?.choices).toEqual([])
  })

  it('message_stop emite done sem chunks', () => {
    const state = createStreamState('m', 'id', 1)
    expect(translateAnthropicEvent({ type: 'message_stop' }, state)).toEqual({ chunks: [], done: true })
  })

  it('error encerra o stream marcado como errored, sem chunks', () => {
    const state = createStreamState('m', 'id', 1)
    const step = translateAnthropicEvent({ type: 'error', error: { message: 'x', type: 'overloaded_error' } }, state)
    expect(step).toEqual({ chunks: [], done: true, errored: true })
  })

  it('reconstrói uma sequência completa de tool call na ordem correta', () => {
    const chunks = run([
      { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path"' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':"a.txt"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ])
    expect(chunks.map((chunk) => chunk.choices[0]?.delta.tool_calls?.[0]?.function?.arguments ?? null)).toEqual([
      '',
      '{"path"',
      ':"a.txt"}',
      null,
      null,
    ])
    expect(chunks.at(-1)?.usage).toEqual({ prompt_tokens: 5, completion_tokens: 12, total_tokens: 17 })
  })
})
