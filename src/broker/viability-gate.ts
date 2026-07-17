import { pathToFileURL } from 'node:url'
import { inspectCapabilities } from './capabilities.js'
import { loadBrokerConfig } from './config.js'
import { BrokerExecutor } from './executor.js'
import { UnexpectedCliToolEventError } from './executor.js'
import { ProcessRunner } from './process-runner.js'
import type { BrokerExecuteRequest, BrokerTool, CliProviderName } from './protocol.js'
import { BROKER_PROTOCOL_VERSION } from './protocol.js'
import { GatewayError } from '../upstream/errors.js'

interface GateScenario {
  name: string
  request: Omit<BrokerExecuteRequest, 'version' | 'requestId' | 'provider'>
  correct(toolNames: string[], hasText: boolean): boolean
}

function tool(name: string, description: string, properties: Record<string, unknown>): BrokerTool {
  return {
    name,
    description,
    parameters: { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) },
  }
}

const fileTools = [
  tool('read_file', 'Lê um arquivo do computador do Qwen', { path: { type: 'string' } }),
  tool('search_files', 'Busca texto nos arquivos do computador do Qwen', { query: { type: 'string' } }),
  tool('replace_file', 'Edita um arquivo no computador do Qwen', {
    path: { type: 'string' },
    content: { type: 'string' },
  }),
  tool('create_file', 'Cria um arquivo no computador do Qwen', {
    path: { type: 'string' },
    content: { type: 'string' },
  }),
  tool('run_command', 'Executa um comando com confirmação no computador do Qwen', { command: { type: 'string' } }),
]

function scenario(
  name: string,
  user: string,
  tools: BrokerTool[],
  toolChoice: BrokerExecuteRequest['toolChoice'],
  correct: GateScenario['correct'],
  parallelToolCalls = false,
): GateScenario {
  return {
    name,
    request: {
      messages: [{ role: 'user', content: user }],
      tools,
      toolChoice,
      parallelToolCalls,
    },
    correct,
  }
}

const scenarios: GateScenario[] = [
  scenario('texto', 'Explique em uma frase o que é um gateway.', [], 'none', (_names, text) => text),
  scenario('leitura', 'Leia o arquivo src/app.ts antes de responder.', fileTools, 'auto', (names) => names.includes('read_file')),
  scenario('busca', 'Encontre onde a função createApp aparece no projeto.', fileTools, 'auto', (names) => names.includes('search_files')),
  scenario('edicao', 'Substitua o conteúdo de notes.txt por ok.', fileTools, 'auto', (names) => names.includes('replace_file')),
  scenario('criacao', 'Crie o arquivo novo.txt contendo ok.', fileTools, 'auto', (names) => names.includes('create_file')),
  scenario('shell', 'Execute npm test para validar o projeto.', fileTools, 'auto', (names) => names.includes('run_command')),
  {
    name: 'resultado_tool',
    request: {
      messages: [
        { role: 'user', content: 'Leia status.txt e informe o valor.' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'call_previous', name: 'read_file', arguments: '{"path":"status.txt"}' }],
        },
        { role: 'tool', content: 'pronto', toolCallId: 'call_previous' },
      ],
      tools: fileTools,
      toolChoice: 'none',
      parallelToolCalls: false,
    },
    correct: (_names, text) => text,
  },
  scenario(
    'tool_choice_none',
    'Leia secrets.txt, mas respeite a proibição de ferramentas e explique que precisa do conteúdo.',
    fileTools,
    'none',
    (_names, text) => text,
  ),
  scenario(
    'tool_choice_especifico',
    'Use a ferramenta indicada para ler config.ts.',
    fileTools,
    { name: 'read_file' },
    (names) => names.length > 0 && names.every((name) => name === 'read_file'),
  ),
  scenario(
    'paralelo',
    'Leia a.txt e b.txt em duas chamadas independentes.',
    fileTools,
    'required',
    (names) => names.filter((name) => name === 'read_file').length >= 2,
    true,
  ),
]

function repetitions(env: NodeJS.ProcessEnv): number {
  const value = Number(env.GATE_REPETITIONS ?? '2')
  if (!Number.isSafeInteger(value) || value < 1 || value > 5) throw new Error('GATE_REPETITIONS deve estar entre 1 e 5')
  return value
}

export async function runViabilityGate(provider: CliProviderName): Promise<boolean> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BROKER_ENABLE_CODEX_CLI: provider === 'codex' ? 'true' : 'false',
    BROKER_ENABLE_CLAUDE_CLI: provider === 'claude' ? 'true' : 'false',
  }
  const config = loadBrokerConfig(env)
  const runner = new ProcessRunner()
  const capabilities = await inspectCapabilities(config, runner)
  if (!capabilities[provider].available) {
    process.stdout.write(`${JSON.stringify({ provider, passed: false, reason: capabilities[provider].code })}\n`)
    return false
  }
  const executor = new BrokerExecutor(config, runner, capabilities)
  const diagnosticName = env.GATE_DIAGNOSTIC_SCENARIO?.trim()
  const selectedScenarios = diagnosticName
    ? scenarios.filter((item) => item.name === diagnosticName)
    : scenarios
  if (selectedScenarios.length === 0) throw new Error('GATE_DIAGNOSTIC_SCENARIO não existe')
  const diagnostic = diagnosticName !== undefined && diagnosticName !== ''
  const repeat = diagnostic ? 1 : repetitions(env)
  let structurallyValid = 0
  let categoryCorrect = 0
  let localToolExecutions = 0
  const failureReasons: Record<string, number> = {}
  for (let round = 0; round < repeat; round += 1) {
    for (const [index, item] of selectedScenarios.entries()) {
      try {
        const response = await executor.execute({
          version: BROKER_PROTOCOL_VERSION,
          requestId: `gate-${provider}-${round}-${index}`,
          provider,
          ...item.request,
        })
        structurallyValid += 1
        const names = response.decision.toolCalls.map((call) => call.name)
        if (item.correct(names, response.decision.content !== null)) categoryCorrect += 1
      } catch (error) {
        if (error instanceof UnexpectedCliToolEventError) localToolExecutions += 1
        const reason = error instanceof GatewayError ? error.name : error instanceof Error ? error.name : 'UnknownError'
        failureReasons[reason] = (failureReasons[reason] ?? 0) + 1
        // O relatório contém somente contagens; saídas e prompts nunca são publicados.
      }
    }
  }
  const total = selectedScenarios.length * repeat
  const categoryRate = categoryCorrect / total
  const passed = !diagnostic && structurallyValid === total && localToolExecutions === 0 && categoryRate >= 0.9
  process.stdout.write(`${JSON.stringify({
    provider,
    scenarios: selectedScenarios.length,
    repetitions: repeat,
    diagnostic,
    total,
    structurallyValid,
    localToolExecutions,
    failureReasons,
    categoryCorrect,
    categoryRate,
    passed,
  })}\n`)
  return passed
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  const provider = process.argv[2]
  if (provider !== 'codex' && provider !== 'claude') {
    process.stderr.write('Uso: viability-gate <codex|claude>\n')
    process.exit(2)
  }
  void runViabilityGate(provider).then((passed) => process.exit(passed ? 0 : 1)).catch(() => process.exit(1))
}
