import { describe, expect, it } from 'vitest'
import type { ChatBody } from '../src/types.js'
import { buildShortNameMap, translateOpenAiToResponses } from '../src/translation/openai-to-responses.js'

function body(overrides: Partial<ChatBody> = {}): ChatBody {
  return {
    model: 'codex-cli',
    messages: [{ role: 'user', content: 'olá' }],
    ...overrides,
  }
}

describe('openai-to-responses', () => {
  it('define campos fixos do corpo', () => {
    const { request } = translateOpenAiToResponses(body(), { model: 'gpt-5.4' })
    expect(request.instructions).toBe('')
    expect(request.store).toBe(false)
    expect(request.include).toEqual(['reasoning.encrypted_content'])
    expect(request.reasoning).toEqual({ effort: 'medium', summary: 'auto' })
  })

  it('usa o effort informado em vez do default', () => {
    const { request } = translateOpenAiToResponses(body(), { model: 'gpt-5.4', effort: 'high' })
    expect(request.reasoning.effort).toBe('high')
  })

  it('não envia temperature, top_p ou max_output_tokens', () => {
    const { request } = translateOpenAiToResponses(
      body({ temperature: 0.5, top_p: 0.9, max_tokens: 100 }),
      { model: 'gpt-5.4' },
    )
    expect(request).not.toHaveProperty('temperature')
    expect(request).not.toHaveProperty('top_p')
    expect(request).not.toHaveProperty('max_output_tokens')
  })

  it('converte role system em item message role developer', () => {
    const { request } = translateOpenAiToResponses(
      body({ messages: [{ role: 'system', content: 'contexto' }, { role: 'user', content: 'oi' }] }),
      { model: 'gpt-5.4' },
    )
    expect(request.input[0]).toEqual({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'contexto' }],
    })
  })

  it('converte texto user em input_text e texto assistant em output_text', () => {
    const { request } = translateOpenAiToResponses(
      body({ messages: [{ role: 'user', content: 'pergunta' }, { role: 'assistant', content: 'resposta' }] }),
      { model: 'gpt-5.4' },
    )
    expect(request.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'pergunta' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'resposta' }] },
    ])
  })

  it('converte image_url em input_image', () => {
    const { request } = translateOpenAiToResponses(
      body({
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/a.png' } }] }],
      }),
      { model: 'gpt-5.4' },
    )
    expect(request.input[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: 'https://x/a.png' }],
    })
  })

  it('converte file.file_data em input_file com filename', () => {
    const { request } = translateOpenAiToResponses(
      body({
        messages: [
          { role: 'user', content: [{ type: 'file', file: { file_data: 'data:application/pdf;base64,AAA', filename: 'a.pdf' } }] },
        ],
      }),
      { model: 'gpt-5.4' },
    )
    expect(request.input[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_file', file_data: 'data:application/pdf;base64,AAA', filename: 'a.pdf' }],
    })
  })

  it('converte input_audio', () => {
    const { request } = translateOpenAiToResponses(
      body({
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AAA', format: 'wav' } }] }],
      }),
      { model: 'gpt-5.4' },
    )
    expect(request.input[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_audio', data: 'AAA', format: 'wav' }],
    })
  })

  it('emite function_call diretamente sem item message quando assistant só tem tool_calls', () => {
    const { request } = translateOpenAiToResponses(
      body({
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
          },
        ],
      }),
      { model: 'gpt-5.4' },
    )
    expect(request.input).toEqual([{ type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' }])
  })

  it('emite item message assistant e function_call quando há texto e tool_calls juntos', () => {
    const { request } = translateOpenAiToResponses(
      body({
        messages: [
          {
            role: 'assistant',
            content: 'vou ler o arquivo',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
          },
        ],
      }),
      { model: 'gpt-5.4' },
    )
    expect(request.input).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'vou ler o arquivo' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
    ])
  })

  it('extrai texto de content em array de partes na mensagem tool', () => {
    const { request } = translateOpenAiToResponses(
      body({
        messages: [
          { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'r1' }, { type: 'text', text: 'r2' }] },
        ],
      }),
      { model: 'gpt-5.4' },
    )
    expect(request.input).toEqual([{ type: 'function_call_output', call_id: 'call_1', output: 'r1r2' }])
  })

  it('ignora partes de conteúdo de tipo desconhecido', () => {
    const { request } = translateOpenAiToResponses(
      body({ messages: [{ role: 'user', content: [{ type: 'algo_nao_suportado' }] }] }),
      { model: 'gpt-5.4' },
    )
    expect(request.input).toEqual([{ type: 'message', role: 'user', content: [] }])
  })

  it('retorna tool_choice indefinido (omitido) quando o valor não é reconhecido', () => {
    const { request } = translateOpenAiToResponses(body({ tool_choice: { type: 'estranho' } }), { model: 'gpt-5.4' })
    expect(request.tool_choice).toBeUndefined()
  })

  it('converte role tool em function_call_output de topo', () => {
    const { request } = translateOpenAiToResponses(
      body({ messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'resultado' }] }),
      { model: 'gpt-5.4' },
    )
    expect(request.input).toEqual([{ type: 'function_call_output', call_id: 'call_1', output: 'resultado' }])
  })

  it('converte tools[].function achatado com strict', () => {
    const { request } = translateOpenAiToResponses(
      body({
        tools: [
          {
            type: 'function',
            function: { name: 'read_file', description: 'lê', parameters: { type: 'object' }, strict: true },
          },
        ],
      }),
      { model: 'gpt-5.4' },
    )
    expect(request.tools).toEqual([
      { type: 'function', name: 'read_file', description: 'lê', parameters: { type: 'object' }, strict: true },
    ])
  })

  it('converte response_format.json_schema em text.format', () => {
    const { request } = translateOpenAiToResponses(
      body({
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'saida', strict: true, schema: { type: 'object' } },
        },
      }),
      { model: 'gpt-5.4' },
    )
    expect(request.text).toEqual({ format: { type: 'json_schema', name: 'saida', strict: true, schema: { type: 'object' } } })
  })

  it('converte tool_choice de função nomeada achatado', () => {
    const { request } = translateOpenAiToResponses(
      body({ tool_choice: { type: 'function', function: { name: 'read_file' } } }),
      { model: 'gpt-5.4' },
    )
    expect(request.tool_choice).toEqual({ type: 'function', name: 'read_file' })
  })

  it('remove parallel_tool_calls quando não há tools no corpo', () => {
    const { request } = translateOpenAiToResponses(body({ parallel_tool_calls: true }), { model: 'gpt-5.4' })
    expect(request).not.toHaveProperty('parallel_tool_calls')
  })

  it('mantém parallel_tool_calls quando há tools', () => {
    const { request } = translateOpenAiToResponses(
      body({
        parallel_tool_calls: false,
        tools: [{ type: 'function', function: { name: 'x', parameters: {} } }],
      }),
      { model: 'gpt-5.4' },
    )
    expect(request.parallel_tool_calls).toBe(false)
  })

  describe('buildShortNameMap', () => {
    it('não altera nomes com até 64 caracteres', () => {
      const map = buildShortNameMap(['read_file'])
      expect(map.originalToShort.size).toBe(0)
    })

    it('encurta nomes acima de 64 caracteres preservando prefixo mcp__ e último segmento, com mapa reverso', () => {
      const longName = `mcp__${'a'.repeat(70)}__minha_ferramenta_finalissima`
      const map = buildShortNameMap([longName])
      const shortened = map.originalToShort.get(longName)
      expect(shortened).toBeDefined()
      expect(shortened?.length).toBeLessThanOrEqual(64)
      expect(shortened?.startsWith('mcp__')).toBe(true)
      expect(shortened?.endsWith('minha_ferramenta_finalissima')).toBe(true)
      expect(map.shortToOriginal.get(shortened as string)).toBe(longName)
    })

    it('resolve colisões entre nomes encurtados', () => {
      const base = 'x'.repeat(80)
      const nameA = `${base}__final`
      const nameB = `${base}2__final`
      const map = buildShortNameMap([nameA, nameB])
      const shortA = map.originalToShort.get(nameA)
      const shortB = map.originalToShort.get(nameB)
      expect(shortA).not.toBe(shortB)
    })
  })

  it('aplica o nome encurtado no tool call e mantém rastreável pelo mapa reverso', () => {
    const longName = `mcp__servidor__${'x'.repeat(60)}`
    const { request, shortNames } = translateOpenAiToResponses(
      body({
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: longName, arguments: '{}' } }],
          },
        ],
        tools: [{ type: 'function', function: { name: longName, parameters: {} } }],
      }),
      { model: 'gpt-5.4' },
    )
    const shortName = shortNames.originalToShort.get(longName)
    expect(shortName?.length).toBeLessThanOrEqual(64)
    expect(request.input).toEqual([{ type: 'function_call', call_id: 'call_1', name: shortName, arguments: '{}' }])
    expect(request.tools?.[0]?.name).toBe(shortName)
    expect(shortNames.shortToOriginal.get(shortName as string)).toBe(longName)
  })

  describe('prompt_cache_key', () => {
    const tools = [{ type: 'function', function: { name: 'read_file', parameters: {} } }]
    const conversaComCall = (callId: string, extras: unknown[] = []): unknown[] => [
      { role: 'system', content: 'você é um agente' },
      { role: 'user', content: 'refatore o módulo de auth' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: callId, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: callId, content: 'conteúdo do arquivo' },
      ...extras,
    ]

    it('permanece estável enquanto a conversa cresce depois da primeira tool call', () => {
      const turno2 = translateOpenAiToResponses(
        body({ messages: conversaComCall('call_abc'), tools }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key

      const turno7 = translateOpenAiToResponses(
        body({
          messages: conversaComCall('call_abc', [
            { role: 'assistant', content: 'entendi' },
            { role: 'user', content: 'siga em frente' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_xyz', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
            },
            { role: 'tool', tool_call_id: 'call_xyz', content: 'outro arquivo' },
          ]),
          tools,
        }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key

      expect(turno2).toBeDefined()
      expect(turno7).toBe(turno2)
    })

    it('separa conversas concorrentes que começam com o mesmo texto (ADR-020, adendo)', () => {
      const conversaA = translateOpenAiToResponses(
        body({ messages: conversaComCall('call_sessao_a'), tools }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key
      const conversaB = translateOpenAiToResponses(
        body({ messages: conversaComCall('call_sessao_b'), tools }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key

      expect(conversaA).toBeDefined()
      expect(conversaB).not.toBe(conversaA)
    })

    it('usa o primeiro call_id do histórico, não o mais recente', () => {
      const semSegundaCall = translateOpenAiToResponses(
        body({ messages: conversaComCall('call_1'), tools }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key
      const comSegundaCall = translateOpenAiToResponses(
        body({
          messages: conversaComCall('call_1', [
            {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
            },
          ]),
          tools,
        }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key

      expect(comSegundaCall).toBe(semSegundaCall)
    })

    it('aceita o call_id vindo só de uma mensagem tool (histórico sem o assistant original)', () => {
      const viaToolResult = translateOpenAiToResponses(
        body({
          messages: [
            { role: 'user', content: 'tarefa' },
            { role: 'tool', tool_call_id: 'call_orfao', content: 'resultado' },
          ],
          tools,
        }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key
      const semTool = translateOpenAiToResponses(
        body({ messages: [{ role: 'user', content: 'tarefa' }], tools }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key

      expect(viaToolResult).toBeDefined()
      expect(viaToolResult).not.toBe(semTool)
    })

    it('cai para o primeiro texto de usuário no primeiro turno, antes de existir call_id', () => {
      const primeiroTurno = translateOpenAiToResponses(
        body({
          messages: [
            { role: 'system', content: 'você é um agente' },
            { role: 'user', content: 'refatore o módulo de auth' },
          ],
          tools,
        }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key
      const mesmoTextoOutraSessao = translateOpenAiToResponses(
        body({
          messages: [
            { role: 'system', content: 'outro system' },
            { role: 'user', content: 'refatore o módulo de auth' },
          ],
          tools,
        }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key

      expect(primeiroTurno).toMatch(/^azigate-[0-9a-f]{32}$/u)
      expect(mesmoTextoOutraSessao).toBe(primeiroTurno)
    })

    it('não confunde um call_id com um texto de usuário de mesmo valor', () => {
      const comoTexto = translateOpenAiToResponses(
        body({ messages: [{ role: 'user', content: 'call_1' }], tools }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key
      const comoCallId = translateOpenAiToResponses(
        body({
          messages: [
            { role: 'user', content: 'call_1' },
            { role: 'tool', tool_call_id: 'call_1', content: 'r' },
          ],
          tools,
        }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key

      expect(comoCallId).not.toBe(comoTexto)
    })

    it('não muda quando apenas o system varia (conteúdo volátil do agente)', () => {
      const comData = translateOpenAiToResponses(
        body({
          messages: [
            { role: 'system', content: 'agora são 10:00, cwd=/a' },
            { role: 'user', content: 'mesma tarefa' },
          ],
          tools,
        }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key
      const outraData = translateOpenAiToResponses(
        body({
          messages: [
            { role: 'system', content: 'agora são 14:35, cwd=/b' },
            { role: 'user', content: 'mesma tarefa' },
          ],
          tools,
        }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key

      expect(comData).toBe(outraData)
    })

    it('separa conversas diferentes e conjuntos de ferramentas diferentes', () => {
      const base = translateOpenAiToResponses(
        body({ messages: [{ role: 'user', content: 'tarefa A' }], tools }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key
      const outraConversa = translateOpenAiToResponses(
        body({ messages: [{ role: 'user', content: 'tarefa B' }], tools }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key
      const outrasFerramentas = translateOpenAiToResponses(
        body({
          messages: [{ role: 'user', content: 'tarefa A' }],
          tools: [...tools, { type: 'function', function: { name: 'write_file', parameters: {} } }],
        }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key

      expect(outraConversa).not.toBe(base)
      expect(outrasFerramentas).not.toBe(base)
    })

    it('mantém as ferramentas no digest mesmo com âncora de call_id', () => {
      const comLeitura = translateOpenAiToResponses(
        body({ messages: conversaComCall('call_1'), tools }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key
      const comEscrita = translateOpenAiToResponses(
        body({
          messages: conversaComCall('call_1'),
          tools: [...tools, { type: 'function', function: { name: 'write_file', parameters: {} } }],
        }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key

      expect(comEscrita).not.toBe(comLeitura)
    })

    it('é opaca: não carrega conteúdo da conversa nem o call_id em claro', () => {
      const { request } = translateOpenAiToResponses(
        body({
          messages: [
            { role: 'user', content: 'PROMPT_ULTRASSECRETO' },
            { role: 'tool', tool_call_id: 'call_IDENTIFICADOR_BRUTO', content: 'r' },
          ],
          tools,
        }),
        { model: 'gpt-5.4' },
      )
      expect(request.prompt_cache_key).toMatch(/^azigate-[0-9a-f]{32}$/u)
      expect(request.prompt_cache_key).not.toContain('PROMPT_ULTRASSECRETO')
      expect(request.prompt_cache_key).not.toContain('call_IDENTIFICADOR_BRUTO')
      expect(request.prompt_cache_key).not.toContain('IDENTIFICADOR')
    })

    it('é omitida quando não há âncora nenhuma', () => {
      const { request } = translateOpenAiToResponses(
        body({ messages: [{ role: 'system', content: 'apenas system' }], tools }),
        { model: 'gpt-5.4' },
      )
      expect(request.prompt_cache_key).toBeUndefined()
    })

    it('lê a âncora de conteúdo multimodal em partes', () => {
      const emPartes = translateOpenAiToResponses(
        body({
          messages: [{ role: 'user', content: [{ type: 'text', text: 'tarefa A' }] }],
          tools,
        }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key
      const texto = translateOpenAiToResponses(
        body({ messages: [{ role: 'user', content: 'tarefa A' }], tools }),
        { model: 'gpt-5.4' },
      ).request.prompt_cache_key

      expect(emPartes).toBe(texto)
    })
  })

  describe('métricas do prompt (TOK-002)', () => {
    const tools = [{ type: 'function', function: { name: 'read_file', description: 'lê', parameters: { type: 'object' } } }]

    it('conta itens de input, ferramentas e bytes de schema', () => {
      const { metrics } = translateOpenAiToResponses(
        body({
          messages: [
            { role: 'system', content: 'agente' },
            { role: 'user', content: 'tarefa' },
          ],
          tools,
        }),
        { model: 'gpt-5.4' },
      )
      expect(metrics.inputItemCount).toBe(2)
      expect(metrics.toolCount).toBe(1)
      expect(metrics.toolSchemaBytes).toBeGreaterThan(0)
    })

    it('zera contagem de ferramentas quando o cliente não declara nenhuma', () => {
      const { metrics } = translateOpenAiToResponses(body(), { model: 'gpt-5.4' })
      expect(metrics.toolCount).toBe(0)
      expect(metrics.toolSchemaBytes).toBe(0)
    })

    it('mantém o prefixFingerprint estável quando só o fim da conversa cresce', () => {
      const prefixo = [
        { role: 'system', content: 'agente' },
        { role: 'user', content: 'tarefa' },
        { role: 'assistant', content: 'primeira resposta' },
      ]
      const turnoA = translateOpenAiToResponses(body({ messages: prefixo }), { model: 'gpt-5.4' }).metrics
      const turnoB = translateOpenAiToResponses(
        body({ messages: [...prefixo, { role: 'user', content: 'continue' }] }),
        { model: 'gpt-5.4' },
      ).metrics

      expect(turnoB.prefixFingerprint).toBe(turnoA.prefixFingerprint)
      expect(turnoB.inputItemCount).toBe(turnoA.inputItemCount + 1)
    })

    it('muda o prefixFingerprint quando o cliente reescreve o começo da conversa', () => {
      const original = translateOpenAiToResponses(
        body({
          messages: [
            { role: 'system', content: 'agente' },
            { role: 'user', content: 'tarefa original' },
          ],
        }),
        { model: 'gpt-5.4' },
      ).metrics
      const compactada = translateOpenAiToResponses(
        body({
          messages: [
            { role: 'system', content: 'agente' },
            { role: 'user', content: 'resumo da conversa anterior' },
          ],
        }),
        { model: 'gpt-5.4' },
      ).metrics

      expect(compactada.prefixFingerprint).not.toBe(original.prefixFingerprint)
    })

    it('é um digest: não revela o conteúdo do prefixo', () => {
      const { metrics } = translateOpenAiToResponses(
        body({ messages: [{ role: 'user', content: 'PROMPT_ULTRASSECRETO' }] }),
        { model: 'gpt-5.4' },
      )
      expect(metrics.prefixFingerprint).toMatch(/^[0-9a-f]{16}$/u)
      expect(metrics.prefixFingerprint).not.toContain('PROMPT')
    })
  })
})
