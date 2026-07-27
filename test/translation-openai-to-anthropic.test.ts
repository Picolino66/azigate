import { describe, expect, it } from 'vitest'
import type { ChatBody } from '../src/types.js'
import { translateOpenAiToAnthropic } from '../src/translation/openai-to-anthropic.js'

function body(overrides: Partial<ChatBody> = {}): ChatBody {
  return {
    model: 'claude-cli',
    messages: [{ role: 'user', content: 'olá' }],
    ...overrides,
  }
}

describe('openai-to-anthropic', () => {
  it('mapeia model, max_tokens default e mensagens de texto simples', () => {
    const result = translateOpenAiToAnthropic(body(), { model: 'claude-sonnet-4-6', defaultMaxTokens: 4096 })
    expect(result.model).toBe('claude-sonnet-4-6')
    expect(result.max_tokens).toBe(4096)
    expect(result.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'olá' }] }])
  })

  it('usa max_tokens do corpo quando presente e válido', () => {
    const result = translateOpenAiToAnthropic(body({ max_tokens: 2048 }), { model: 'm', defaultMaxTokens: 4096 })
    expect(result.max_tokens).toBe(2048)
  })

  it('ignora max_tokens inválido e usa o default', () => {
    const result = translateOpenAiToAnthropic(body({ max_tokens: -1 }), { model: 'm', defaultMaxTokens: 999 })
    expect(result.max_tokens).toBe(999)
  })

  it('converte mensagens system em blocos no array system', () => {
    const result = translateOpenAiToAnthropic(
      body({ messages: [{ role: 'system', content: 'Você é útil' }, { role: 'user', content: 'oi' }] }),
      { model: 'm', defaultMaxTokens: 100 },
    )
    expect(result.system).toEqual([{ type: 'text', text: 'Você é útil' }])
  })

  it('injeta turno de usuário mínimo quando não há mensagens', () => {
    const result = translateOpenAiToAnthropic(
      body({ messages: [{ role: 'system', content: 'contexto' }] }),
      { model: 'm', defaultMaxTokens: 100 },
    )
    expect(result.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: '' }] }])
  })

  it('converte image_url com data: em bloco base64', () => {
    const result = translateOpenAiToAnthropic(
      body({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'veja' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
            ],
          },
        ],
      }),
      { model: 'm', defaultMaxTokens: 100 },
    )
    expect(result.messages[0]?.content).toEqual([
      { type: 'text', text: 'veja' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ])
  })

  it('converte image_url http em bloco url', () => {
    const result = translateOpenAiToAnthropic(
      body({
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://exemplo.com/a.png' } }] },
        ],
      }),
      { model: 'm', defaultMaxTokens: 100 },
    )
    expect(result.messages[0]?.content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://exemplo.com/a.png' } },
    ])
  })

  it('converte file.file_data com data: em bloco document base64', () => {
    const result = translateOpenAiToAnthropic(
      body({
        messages: [
          {
            role: 'user',
            content: [{ type: 'file', file: { file_data: 'data:application/pdf;base64,UERG' } }],
          },
        ],
      }),
      { model: 'm', defaultMaxTokens: 100 },
    )
    expect(result.messages[0]?.content).toEqual([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'UERG' } },
    ])
  })

  it('converte assistant.tool_calls em blocos tool_use no mesmo content', () => {
    const result = translateOpenAiToAnthropic(
      body({
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_123', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
            ],
          },
        ],
      }),
      { model: 'm', defaultMaxTokens: 100 },
    )
    expect(result.messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_123', name: 'read_file', input: { path: 'a.txt' } }],
    })
  })

  it('gera id toolu_ quando tool_call não tem id ou o id é inválido', () => {
    const result = translateOpenAiToAnthropic(
      body({
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'id com espaço', type: 'function', function: { name: 'x', arguments: '{}' } }],
          },
        ],
      }),
      { model: 'm', defaultMaxTokens: 100 },
    )
    const block = result.messages[0]?.content[0]
    expect(block?.type).toBe('tool_use')
    expect((block as { id: string }).id).toMatch(/^toolu_[a-f0-9]+$/)
  })

  it('usa {} quando arguments não é JSON válido ou não é objeto', () => {
    const result = translateOpenAiToAnthropic(
      body({
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'x', arguments: 'não é json' } }],
          },
        ],
      }),
      { model: 'm', defaultMaxTokens: 100 },
    )
    expect((result.messages[0]?.content[0] as { input: unknown }).input).toEqual({})
  })

  it('converte role tool + tool_call_id em mensagem user com tool_result referenciando o mesmo id sanitizado', () => {
    const result = translateOpenAiToAnthropic(
      body({
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'x', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'resultado' },
        ],
      }),
      { model: 'm', defaultMaxTokens: 100 },
    )
    const assistantBlock = result.messages[0]?.content[0] as { id: string }
    expect(result.messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: assistantBlock.id, content: 'resultado' }],
    })
  })

  it('agrupa múltiplos resultados de tool consecutivos em uma única mensagem user', () => {
    const result = translateOpenAiToAnthropic(
      body({
        messages: [
          { role: 'tool', tool_call_id: 'call_1', content: 'r1' },
          { role: 'tool', tool_call_id: 'call_2', content: 'r2' },
        ],
      }),
      { model: 'm', defaultMaxTokens: 100 },
    )
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.content).toHaveLength(2)
  })

  it('mapeia top_p e converte stop string/array em stop_sequences array', () => {
    const single = translateOpenAiToAnthropic(body({ top_p: 0.5, stop: 'FIM' }), { model: 'm', defaultMaxTokens: 100 })
    expect(single.top_p).toBe(0.5)
    expect(single.stop_sequences).toEqual(['FIM'])

    const multi = translateOpenAiToAnthropic(body({ stop: ['A', 'B'] }), { model: 'm', defaultMaxTokens: 100 })
    expect(multi.stop_sequences).toEqual(['A', 'B'])
  })

  it('mapeia stream', () => {
    expect(translateOpenAiToAnthropic(body({ stream: true }), { model: 'm', defaultMaxTokens: 100 }).stream).toBe(true)
  })

  it('converte tools[].function em tools[] com input_schema', () => {
    const result = translateOpenAiToAnthropic(
      body({
        tools: [
          {
            type: 'function',
            function: { name: 'read_file', description: 'lê', parameters: { type: 'object', properties: {} } },
          },
        ],
      }),
      { model: 'm', defaultMaxTokens: 100 },
    )
    expect(result.tools).toEqual([
      { name: 'read_file', description: 'lê', input_schema: { type: 'object', properties: {} } },
    ])
  })

  it.each([
    ['auto', { type: 'auto' }],
    ['required', { type: 'any' }],
    ['none', { type: 'none' }],
  ] as const)('mapeia tool_choice %s', (input, expected) => {
    const result = translateOpenAiToAnthropic(body({ tool_choice: input }), { model: 'm', defaultMaxTokens: 100 })
    expect(result.tool_choice).toEqual(expected)
  })

  it('mapeia tool_choice de função nomeada', () => {
    const result = translateOpenAiToAnthropic(
      body({ tool_choice: { type: 'function', function: { name: 'read_file' } } }),
      { model: 'm', defaultMaxTokens: 100 },
    )
    expect(result.tool_choice).toEqual({ type: 'tool', name: 'read_file' })
  })

  it('mapeia reasoning_effort para thinking adaptive + output_config por default', () => {
    const result = translateOpenAiToAnthropic(body(), { model: 'm', defaultMaxTokens: 100, effort: 'high' })
    expect(result.thinking).toEqual({ type: 'adaptive' })
    expect(result.output_config).toEqual({ effort: 'high' })
  })

  it('mapeia reasoning_effort para thinking budget_tokens quando a tabela é fornecida', () => {
    const result = translateOpenAiToAnthropic(body(), {
      model: 'm',
      defaultMaxTokens: 100,
      effort: 'high',
      thinkingBudgetTokens: { low: 1000, medium: 2000, high: 4000, xhigh: 8000, max: 16_000 },
    })
    expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 4000 })
    expect(result.output_config).toBeUndefined()
  })

  it('extrai texto de content em formato array de partes (histórico assistant/tool)', () => {
    const result = translateOpenAiToAnthropic(
      body({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'parte 1' }, { type: 'text', text: ' parte 2' }],
          },
        ],
      }),
      { model: 'm', defaultMaxTokens: 100 },
    )
    expect(result.messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'parte 1 parte 2' }],
    })
  })

  it('ignora partes de conteúdo de tipo desconhecido', () => {
    const result = translateOpenAiToAnthropic(
      body({ messages: [{ role: 'user', content: [{ type: 'algo_nao_suportado' }] }] }),
      { model: 'm', defaultMaxTokens: 100 },
    )
    expect(result.messages[0]?.content).toEqual([{ type: 'text', text: '' }])
  })

  it('retorna tool_choice indefinido (omitido) quando o valor não é reconhecido', () => {
    const result = translateOpenAiToAnthropic(body({ tool_choice: { type: 'estranho' } }), {
      model: 'm',
      defaultMaxTokens: 100,
    })
    expect(result.tool_choice).toBeUndefined()
  })

  it('preserva ferramentas nativas não-function (ex.: web_search) e remove allowed_domains/blocked_domains vazios', () => {
    const result = translateOpenAiToAnthropic(
      body({
        tools: [
          { type: 'web_search_20250305', name: 'web_search', allowed_domains: [], blocked_domains: [] },
        ],
      }),
      { model: 'm', defaultMaxTokens: 100 },
    )
    expect(result.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search' }])
  })

  it('preserva allowed_domains/blocked_domains não vazios em ferramentas nativas', () => {
    const result = translateOpenAiToAnthropic(
      body({ tools: [{ type: 'web_search_20250305', name: 'web_search', allowed_domains: ['exemplo.com'] }] }),
      { model: 'm', defaultMaxTokens: 100 },
    )
    expect(result.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', allowed_domains: ['exemplo.com'] }])
  })

  it('remove temperature e top_p quando thinking está ativo', () => {
    const result = translateOpenAiToAnthropic(body({ temperature: 0.7, top_p: 0.9 }), {
      model: 'm',
      defaultMaxTokens: 100,
      effort: 'high',
    })
    expect(result.temperature).toBeUndefined()
    expect(result.top_p).toBeUndefined()
  })
})
