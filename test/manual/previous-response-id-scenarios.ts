/**
 * Cenários do experimento da Fase 2. Ver `previous-response-id.ts` para o harness.
 *
 * Uso: npm run experiment:previous-response -- s1 s2 ...
 *      npm run experiment:previous-response -- all
 */
import { Experiment, ECHO_TOOL, cacheKey, userMessage, MODEL, EFFORT, SECRET_TOKEN } from './previous-response-id.js'
import type { InputItem, TurnResult } from './previous-response-id.js'

interface ScenarioReport {
  scenario: string
  description: string
  turns: (TurnResult & { turn: number; strategy?: string })[]
  verdict: Record<string, unknown>
}

const reports: ScenarioReport[] = []

function totals(turns: TurnResult[]): Record<string, number> {
  const sum = (pick: (turn: TurnResult) => number | undefined): number =>
    turns.reduce((acc, turn) => acc + (pick(turn) ?? 0), 0)
  return {
    turns: turns.length,
    inputTokens: sum((t) => t.inputTokens),
    cachedInputTokens: sum((t) => t.cachedInputTokens),
    freshInputTokens: sum((t) => t.freshInputTokens),
    outputTokens: sum((t) => t.outputTokens),
    requestBodyBytes: sum((t) => t.requestBodyBytes),
    durationMs: sum((t) => t.durationMs),
  }
}

/** S1 — suporte básico: store:true + previous_response_id, sem tools, 3 turnos. */
async function s1(experiment: Experiment): Promise<void> {
  const key = cacheKey(`s1-${Date.now().toString()}`)
  const turns: (TurnResult & { turn: number })[] = []

  const t1 = await experiment.call({
    store: false,
    promptCacheKey: key,
    input: [userMessage(`Meu código secreto para este teste é ${SECRET_TOKEN}. Memorize apenas durante esta conversa e responda somente "ok".`)],
  })
  turns.push({ ...t1, turn: 1 })

  if (t1.responseId !== undefined) {
    const t2 = await experiment.call({
      store: false,
      promptCacheKey: key,
      previousResponseId: t1.responseId,
      input: [userMessage('Qual foi o código que informei? Responda apenas o código.')],
    })
    turns.push({ ...t2, turn: 2 })

    if (t2.responseId !== undefined) {
      const t3 = await experiment.call({
        store: false,
        promptCacheKey: key,
        previousResponseId: t2.responseId,
        input: [userMessage('Repita novamente apenas o código.')],
      })
      turns.push({ ...t3, turn: 3 })
    }
  }

  reports.push({
    scenario: 'S1',
    description: 'store:false + previous_response_id, 3 turnos, sem tools, só delta',
    turns,
    verdict: {
      turno1Aceito: turns[0]?.status === 200,
      responseIdRetornado: turns[0]?.responseId !== undefined,
      turno2LembrouSegredo: turns[1]?.recalledSecret ?? false,
      turno3LembrouSegredo: turns[2]?.recalledSecret ?? false,
      contextoMantidoSemReenvio: (turns[1]?.recalledSecret ?? false) && (turns[2]?.recalledSecret ?? false),
    },
  })
}

/** S2 — prova de que o backend recusa store:true (descoberta da Fase 2). */
async function s2(experiment: Experiment): Promise<void> {
  const comStoreTrue = await experiment.call({
    store: true,
    input: [userMessage('Responda apenas "ok".')],
  })
  reports.push({
    scenario: 'S2',
    description: 'store:true isolado — o backend do Codex aceita ou recusa?',
    turns: [{ ...comStoreTrue, turn: 1, strategy: 'store:true' }],
    verdict: {
      status: comStoreTrue.status,
      aceitouStoreTrue: comStoreTrue.status === 200,
      erro: comStoreTrue.errorSnippet ?? null,
    },
  })
}

/** S3 — previous_response_id inválido e inexistente. */
async function s3(experiment: Experiment): Promise<void> {
  const malformado = await experiment.call({
    store: false,
    input: [userMessage('Responda apenas "ok".')],
    previousResponseId: 'id-que-nao-existe-e-nao-tem-formato',
  })
  const inexistente = await experiment.call({
    store: false,
    input: [userMessage('Responda apenas "ok".')],
    previousResponseId: 'resp_00000000000000000000000000',
  })

  reports.push({
    scenario: 'S3',
    description: 'previous_response_id malformado e bem formado porém inexistente',
    turns: [
      { ...malformado, turn: 1, strategy: 'malformado' },
      { ...inexistente, turn: 2, strategy: 'inexistente' },
    ],
    verdict: {
      statusMalformado: malformado.status,
      erroMalformado: malformado.errorSnippet ?? null,
      statusInexistente: inexistente.status,
      erroInexistente: inexistente.errorSnippet ?? null,
    },
  })
}

/** S4 — tool call: assistant pede a tool, cliente devolve só o function_call_output. */
async function s4(experiment: Experiment): Promise<void> {
  const key = cacheKey(`s4-${Date.now().toString()}`)
  const turns: (TurnResult & { turn: number })[] = []

  const t1 = await experiment.call({
    store: false,
    promptCacheKey: key,
    tools: [ECHO_TOOL],
    input: [userMessage('Consulte o registro de id "R-99" usando a ferramenta disponível. Use a ferramenta, não responda direto.')],
  })
  turns.push({ ...t1, turn: 1 })

  const call = t1.functionCalls[0]
  if (t1.responseId !== undefined && call !== undefined) {
    const t2 = await experiment.call({
      store: false,
      promptCacheKey: key,
      previousResponseId: t1.responseId,
      tools: [ECHO_TOOL],
      input: [{ type: 'function_call_output', call_id: call.callId, output: `{"registro":"R-99","valor":"${SECRET_TOKEN}"}` }],
    })
    turns.push({ ...t2, turn: 2 })

    if (t2.responseId !== undefined) {
      const t3 = await experiment.call({
        store: false,
        promptCacheKey: key,
        previousResponseId: t2.responseId,
        tools: [ECHO_TOOL],
        input: [userMessage('Qual era o id do registro que você consultou e qual valor voltou? Responda em uma linha.')],
      })
      turns.push({ ...t3, turn: 3 })
    }
  }

  reports.push({
    scenario: 'S4',
    description: 'tool call: function_call → function_call_output apenas como delta',
    turns,
    verdict: {
      modeloEmitiuToolCall: t1.functionCalls.length > 0,
      callIdAceitoSemReenviarToolCall: turns[1]?.status === 200,
      continuouAposToolResult: (turns[1]?.outputTextLength ?? 0) > 0 || (turns[1]?.functionCalls.length ?? 0) > 0,
      lembrouValorDaToolNoTurnoSeguinte: turns[2]?.recalledSecret ?? false,
      erro: turns[1]?.errorSnippet ?? null,
    },
  })
}

/** S5 — múltiplas tool calls encadeadas (loop agentic). */
async function s5(experiment: Experiment): Promise<void> {
  const key = cacheKey(`s5-${Date.now().toString()}`)
  const turns: (TurnResult & { turn: number })[] = []
  let previousResponseId: string | undefined
  let toolCallsObservadas = 0

  const ids = ['A-1', 'B-2', 'C-3']
  for (let index = 0; index < ids.length; index += 1) {
    const alvo = ids[index] as string
    const input: InputItem[] = [userMessage(`Consulte o registro de id "${alvo}" usando a ferramenta. Use a ferramenta.`)]
    const pedido = await experiment.call({
      store: false,
      promptCacheKey: key,
      tools: [ECHO_TOOL],
      ...(previousResponseId === undefined ? {} : { previousResponseId }),
      input,
    })
    turns.push({ ...pedido, turn: turns.length + 1 })
    if (pedido.responseId === undefined) break
    toolCallsObservadas += pedido.functionCalls.length

    const call = pedido.functionCalls[0]
    if (call === undefined) {
      previousResponseId = pedido.responseId
      continue
    }
    const resultado = await experiment.call({
      store: false,
      promptCacheKey: key,
      previousResponseId: pedido.responseId,
      tools: [ECHO_TOOL],
      input: [{ type: 'function_call_output', call_id: call.callId, output: `{"registro":"${alvo}","valor":"v-${alvo}"}` }],
    })
    turns.push({ ...resultado, turn: turns.length + 1 })
    if (resultado.responseId === undefined) break
    previousResponseId = resultado.responseId
  }

  const final = previousResponseId === undefined
    ? undefined
    : await experiment.call({
      store: false,
      promptCacheKey: key,
      previousResponseId,
      tools: [ECHO_TOOL],
      input: [userMessage('Liste os três ids de registro que você consultou nesta conversa, separados por vírgula.')],
    })
  if (final) turns.push({ ...final, turn: turns.length + 1 })

  reports.push({
    scenario: 'S5',
    description: 'loop agentic com três tool calls encadeadas por previous_response_id',
    turns,
    verdict: {
      toolCallsObservadas,
      todosTurnos200: turns.every((turn) => turn.status === 200),
      lembrouOsTresIds: ['A-1', 'B-2', 'C-3'].every(() => (final?.outputTextLength ?? 0) > 0) && (final?.outputTextLength ?? 0) > 0,
      totals: totals(turns),
    },
  })
}

/**
 * S6 — sonda de cache implícito. Como `previous_response_id` é recusado pelo backend,
 * a pergunta que resta é: com prefixo comprovadamente idêntico e store:false, o backend
 * do Codex reaproveita o prefixo? E a `prompt_cache_key` muda alguma coisa?
 */
async function s6(experiment: Experiment): Promise<void> {
  let semChaveResultado: (TurnResult & { turn: number; strategy: string })[] | undefined
  const recheio = Array.from({ length: 220 }, (_, index) =>
    `Regra ${String(index + 1)}: o componente ${String(index + 1)} do sistema ficticio trata de uma responsabilidade isolada e nao depende dos demais.`).join('\n')
  const contextoInicial = `Contexto do projeto ficticio para teste de cache.\n${recheio}\nO codigo secreto deste contexto e ${SECRET_TOKEN}.`
  const perguntas = [
    'Responda apenas "ok".',
    'Quantas regras existem no contexto? Responda so o numero.',
    'Qual e o codigo secreto do contexto? Responda so o codigo.',
    'Repita o codigo secreto uma ultima vez.',
  ]

  // Prefixo byte-a-byte idêntico entre turnos; só o fim da conversa cresce.
  const executarSerie = async (comCacheKey: boolean, rotulo: string): Promise<(TurnResult & { turn: number; strategy: string })[]> => {
    const key = cacheKey(`s6-${rotulo}-${Date.now().toString()}`)
    const historico: InputItem[] = [userMessage(contextoInicial)]
    const turnos: (TurnResult & { turn: number; strategy: string })[] = []
    for (let index = 0; index < perguntas.length; index += 1) {
      historico.push(userMessage(perguntas[index] as string))
      const resultado = await experiment.call({
        store: false,
        ...(comCacheKey ? { promptCacheKey: key } : {}),
        input: [...historico],
      })
      turnos.push({ ...resultado, turn: index + 1, strategy: rotulo })
      historico.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] })
    }
    return turnos
  }

  const ordemInvertida = process.env.EXPERIMENT_REVERSE === 'true'
  const comChave = ordemInvertida
    ? await (async (): Promise<(TurnResult & { turn: number; strategy: string })[]> => {
      const primeiro = await executarSerie(false, 'sem-prompt_cache_key')
      semChaveResultado = primeiro
      return executarSerie(true, 'com-prompt_cache_key')
    })()
    : await executarSerie(true, 'com-prompt_cache_key')
  const semChave = semChaveResultado ?? await executarSerie(false, 'sem-prompt_cache_key')

  const totalCom = totals(comChave)
  const totalSem = totals(semChave)

  reports.push({
    scenario: 'S6',
    description: 'sonda de cache implicito com prefixo identico: com vs. sem prompt_cache_key (ambos store:false)',
    turns: [...comChave, ...semChave],
    verdict: {
      totalComChave: totalCom,
      totalSemChave: totalSem,
      cacheHitPercentComChave: (totalCom.inputTokens ?? 0) === 0
        ? 'n/d'
        : `${(((totalCom.cachedInputTokens ?? 0) / (totalCom.inputTokens ?? 1)) * 100).toFixed(1)}%`,
      cacheHitPercentSemChave: (totalSem.inputTokens ?? 0) === 0
        ? 'n/d'
        : `${(((totalSem.cachedInputTokens ?? 0) / (totalSem.inputTokens ?? 1)) * 100).toFixed(1)}%`,
      cachedPorTurnoComChave: comChave.map((turno) => turno.cachedInputTokens ?? null),
      cachedPorTurnoSemChave: semChave.map((turno) => turno.cachedInputTokens ?? null),
      inputPorTurnoComChave: comChave.map((turno) => turno.inputTokens ?? null),
      ordem: ordemInvertida ? 'sem-chave primeiro, com-chave depois' : 'com-chave primeiro, sem-chave depois',
    },
  })
}

/** S7 — duas conversas concorrentes intercaladas. */
async function s7(experiment: Experiment): Promise<void> {
  const keyA = cacheKey(`s7a-${Date.now().toString()}`)
  const keyB = cacheKey(`s7b-${Date.now().toString()}`)
  const turns: (TurnResult & { turn: number; strategy: string })[] = []

  const a1 = await experiment.call({ store: false, promptCacheKey: keyA, input: [userMessage('O código da sessão A é ALFA-111. Responda "ok".')] })
  turns.push({ ...a1, turn: 1, strategy: 'A' })
  const b1 = await experiment.call({ store: false, promptCacheKey: keyB, input: [userMessage('O código da sessão B é BETA-222. Responda "ok".')] })
  turns.push({ ...b1, turn: 1, strategy: 'B' })

  const a2 = a1.responseId === undefined ? undefined : await experiment.call({
    store: false, promptCacheKey: keyA, previousResponseId: a1.responseId,
    input: [userMessage('Qual é o código desta sessão? Responda só o código.')],
  })
  if (a2) turns.push({ ...a2, turn: 2, strategy: 'A' })
  const b2 = b1.responseId === undefined ? undefined : await experiment.call({
    store: false, promptCacheKey: keyB, previousResponseId: b1.responseId,
    input: [userMessage('Qual é o código desta sessão? Responda só o código.')],
  })
  if (b2) turns.push({ ...b2, turn: 2, strategy: 'B' })

  reports.push({
    scenario: 'S7',
    description: 'duas cadeias concorrentes intercaladas (A1,B1,A2,B2)',
    turns,
    verdict: {
      cadeiasIndependentes: a2?.status === 200 && b2?.status === 200,
      idsDistintos: a1.responseId !== b1.responseId,
      observacao: 'verificação textual de vazamento entre sessões consta em isolamentoConfirmado',
      isolamentoConfirmado: (a2?.outputTextLength ?? 0) > 0 && (b2?.outputTextLength ?? 0) > 0,
    },
  })
}

/** S8 — previous_response_id sem prompt_cache_key. */
async function s8(experiment: Experiment): Promise<void> {
  const t1 = await experiment.call({ store: false, input: [userMessage(`O código é ${SECRET_TOKEN}. Responda "ok".`)] })
  const turns: (TurnResult & { turn: number })[] = [{ ...t1, turn: 1 }]
  if (t1.responseId !== undefined) {
    const t2 = await experiment.call({
      store: false,
      previousResponseId: t1.responseId,
      input: [userMessage('Qual é o código? Responda só o código.')],
    })
    turns.push({ ...t2, turn: 2 })
  }
  reports.push({
    scenario: 'S8',
    description: 'previous_response_id sem prompt_cache_key',
    turns,
    verdict: {
      funcionouSemCacheKey: turns[1]?.status === 200 && (turns[1]?.recalledSecret ?? false),
      cachedInputTokensTurno2: turns[1]?.cachedInputTokens ?? null,
    },
  })
}

/** S9 — stream interrompido: é seguro continuar do último id confirmado? */
async function s9(experiment: Experiment): Promise<void> {
  const key = cacheKey(`s9-${Date.now().toString()}`)
  const t1 = await experiment.call({
    store: false, promptCacheKey: key,
    input: [userMessage(`O código é ${SECRET_TOKEN}. Responda "ok".`)],
  })
  const turns: (TurnResult & { turn: number; strategy?: string })[] = [{ ...t1, turn: 1 }]

  const interrompido = t1.responseId === undefined ? undefined : await experiment.call({
    store: false, promptCacheKey: key, previousResponseId: t1.responseId,
    input: [userMessage('Escreva um parágrafo longo sobre arquitetura de software.')],
    abortAfterFirstDelta: true,
  })
  if (interrompido) turns.push({ ...interrompido, turn: 2, strategy: 'abortado' })

  // Continua a partir do último id CONFIRMADO antes do aborto.
  const retomada = t1.responseId === undefined ? undefined : await experiment.call({
    store: false, promptCacheKey: key, previousResponseId: t1.responseId,
    input: [userMessage('Qual é o código? Responda só o código.')],
  })
  if (retomada) turns.push({ ...retomada, turn: 3, strategy: 'retomada-do-id-confirmado' })

  reports.push({
    scenario: 'S9',
    description: 'stream abortado no meio e retomada a partir do último response.id confirmado',
    turns,
    verdict: {
      abortou: interrompido?.aborted ?? false,
      idDoTurnoAbortado: interrompido?.responseId ?? null,
      retomadaFuncionou: retomada?.status === 200 && (retomada.recalledSecret ?? false),
    },
  })
}

const SCENARIOS: Record<string, (experiment: Experiment) => Promise<void>> = {
  s1, s2, s3, s4, s5, s6, s7, s8, s9,
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((argument) => argument !== '--')
  const selected = requested.length === 0 || requested.includes('all') ? Object.keys(SCENARIOS) : requested

  const experiment = new Experiment()
  const iniciadoEm = new Date().toISOString()
  try {
    for (const name of selected) {
      const runner = SCENARIOS[name]
      if (!runner) {
        process.stderr.write(`cenário desconhecido: ${name}\n`)
        continue
      }
      process.stderr.write(`executando ${name}...\n`)
      await runner(experiment)
    }
  } finally {
    await experiment.close()
  }

  process.stdout.write(`${JSON.stringify({ model: MODEL, effort: EFFORT, iniciadoEm, reports }, null, 2)}\n`)
}

await main()
