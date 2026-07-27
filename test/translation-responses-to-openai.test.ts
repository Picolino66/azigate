import { describe, expect, it } from 'vitest'
import { createStreamState } from '../src/translation/state.js'
import { translateResponsesEvent, type ResponsesStreamEvent } from '../src/translation/responses-to-openai.js'
import { buildShortNameMap } from '../src/translation/openai-to-responses.js'

function run(events: ResponsesStreamEvent[], shortNames?: ReturnType<typeof buildShortNameMap>) {
  const state = createStreamState('placeholder', 'placeholder', 1_700_000_000, shortNames)
  return events.flatMap((event) => translateResponsesEvent(event, state).chunks)
}

describe('responses-to-openai', () => {
  it('response.created captura id/model e não emite chunk', () => {
    const state = createStreamState('placeholder', 'placeholder', 1)
    const step = translateResponsesEvent(
      { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.4', created_at: 123 } },
      state,
    )
    expect(step).toEqual({ chunks: [], done: false })
    expect(state.id).toBe('resp_1')
    expect(state.model).toBe('gpt-5.4')
  })

  it('response.output_text.delta emite delta.content com role na primeira vez', () => {
    const state = createStreamState('m', 'id', 1)
    const first = translateResponsesEvent({ type: 'response.output_text.delta', delta: 'oi' }, state)
    expect(first.chunks[0]?.choices[0]?.delta).toEqual({ role: 'assistant', content: 'oi' })
    const second = translateResponsesEvent({ type: 'response.output_text.delta', delta: ' tudo bem' }, state)
    expect(second.chunks[0]?.choices[0]?.delta).toEqual({ content: ' tudo bem' })
  })

  it('response.reasoning_summary_text.delta emite delta.reasoning_content', () => {
    const state = createStreamState('m', 'id', 1)
    const step = translateResponsesEvent({ type: 'response.reasoning_summary_text.delta', delta: 'pensando' }, state)
    expect(step.chunks[0]?.choices[0]?.delta.reasoning_content).toBe('pensando')
  })

  it('response.output_item.added com function_call incrementa índice e emite tool_calls', () => {
    const state = createStreamState('m', 'id', 1)
    const step = translateResponsesEvent(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'read_file' },
      },
      state,
    )
    expect(step.chunks[0]?.choices[0]?.delta.tool_calls).toEqual([
      { index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } },
    ])
  })

  it('response.output_item.added ignora itens que não são function_call', () => {
    const state = createStreamState('m', 'id', 1)
    const step = translateResponsesEvent(
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
      state,
    )
    expect(step).toEqual({ chunks: [], done: false })
  })

  it('response.function_call_arguments.delta emite argumentos parciais no índice correto', () => {
    const state = createStreamState('m', 'id', 1)
    translateResponsesEvent(
      { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'call_1', name: 'x' } },
      state,
    )
    const step = translateResponsesEvent(
      { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"a":1' },
      state,
    )
    expect(step.chunks[0]?.choices[0]?.delta.tool_calls).toEqual([{ index: 0, function: { arguments: '{"a":1' } }])
  })

  it('response.function_call_arguments.done só emite quando nenhum delta chegou antes', () => {
    const withDeltas = createStreamState('m', 'id', 1)
    translateResponsesEvent(
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c', name: 'x' } },
      withDeltas,
    )
    translateResponsesEvent({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' }, withDeltas)
    const doneAfterDeltas = translateResponsesEvent(
      { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{}' },
      withDeltas,
    )
    expect(doneAfterDeltas.chunks).toEqual([])

    const withoutDeltas = createStreamState('m', 'id', 1)
    translateResponsesEvent(
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c', name: 'x' } },
      withoutDeltas,
    )
    const doneWithoutDeltas = translateResponsesEvent(
      { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"a":1}' },
      withoutDeltas,
    )
    expect(doneWithoutDeltas.chunks[0]?.choices[0]?.delta.tool_calls).toEqual([
      { index: 0, function: { arguments: '{"a":1}' } },
    ])
  })

  it('response.output_item.done funciona como fallback quando o item nunca foi anunciado', () => {
    const state = createStreamState('m', 'id', 1)
    const step = translateResponsesEvent(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
      },
      state,
    )
    expect(step.chunks[0]?.choices[0]?.delta.tool_calls).toEqual([
      { index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
    ])
  })

  it('response.output_item.done não duplica quando o item já foi anunciado por added', () => {
    const state = createStreamState('m', 'id', 1)
    translateResponsesEvent(
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c', name: 'x' } },
      state,
    )
    const step = translateResponsesEvent(
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c', name: 'x', arguments: '{}' } },
      state,
    )
    expect(step.chunks).toEqual([])
  })

  it('response.output_item.done sem name nem call_id não inclui esses campos e não emite role se já emitida', () => {
    const state = createStreamState('m', 'id', 1)
    state.roleEmitted = true
    const step = translateResponsesEvent(
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } },
      state,
    )
    expect(step.chunks[0]?.choices[0]?.delta).toEqual({
      tool_calls: [{ index: 0, type: 'function', function: { arguments: '' } }],
    })
  })

  it.each([
    [false, 'stop'],
    [true, 'tool_calls'],
  ])('response.completed mapeia finish_reason conforme houve tool call (%s -> %s)', (hadToolCall, finishReason) => {
    const state = createStreamState('m', 'id', 1)
    if (hadToolCall) {
      translateResponsesEvent(
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c', name: 'x' } },
        state,
      )
    }
    const step = translateResponsesEvent({ type: 'response.completed', response: {} }, state)
    expect(step.chunks[0]?.choices[0]?.finish_reason).toBe(finishReason)
    expect(step.done).toBe(true)
  })

  it.each([
    [undefined, 'stop'],
    ['max_output_tokens', 'length'],
    ['content_filter', 'content_filter'],
  ] as const)('response.incomplete mapeia incomplete_details.reason %s para %s', (reason, finishReason) => {
    const state = createStreamState('m', 'id', 1)
    const step = translateResponsesEvent(
      { type: 'response.incomplete', response: { ...(reason === undefined ? {} : { incomplete_details: { reason } }) } },
      state,
    )
    expect(step.chunks[0]?.choices[0]?.finish_reason).toBe(finishReason)
    expect(step.done).toBe(true)
  })

  it('mapeia usage com cached_tokens e reasoning_tokens', () => {
    const state = createStreamState('m', 'id', 1)
    const step = translateResponsesEvent(
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 100,
            output_tokens: 40,
            total_tokens: 140,
            input_tokens_details: { cached_tokens: 30 },
            output_tokens_details: { reasoning_tokens: 10 },
          },
        },
      },
      state,
    )
    const usageChunk = step.chunks.find((chunk) => chunk.usage !== undefined)
    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 30 },
      completion_tokens_details: { reasoning_tokens: 10 },
    })
  })

  it('restaura o nome original da ferramenta usando o mapa reverso de nomes encurtados', () => {
    const longName = `mcp__servidor__${'x'.repeat(60)}`
    const shortNames = buildShortNameMap([longName])
    const shortName = shortNames.originalToShort.get(longName) as string
    const chunks = run(
      [{ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c', name: shortName } }],
      shortNames,
    )
    expect(chunks[0]?.choices[0]?.delta.tool_calls?.[0]?.function?.name).toBe(longName)
  })

  it('reconstrói uma sequência completa de tool call na ordem correta', () => {
    const chunks = run([
      { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.4', created_at: 1 } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'read_file' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path"' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: ':"a.txt"}' },
      { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"path":"a.txt"}' },
      { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 8, total_tokens: 13 } } },
    ])
    expect(chunks.map((chunk) => chunk.choices[0]?.delta.tool_calls?.[0]?.function?.arguments ?? null)).toEqual([
      '',
      '{"path"',
      ':"a.txt"}',
      null,
      null,
    ])
    expect(chunks.at(-1)?.usage).toEqual({ prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 })
  })
})
