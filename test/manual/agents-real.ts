// Suíte REAL e manual do Agent Plane (npm run test:agents:real). Consome cota das CLIs.
// Nunca roda na suíte comum e nunca aponta para um projeto real: cria um workspace
// temporário com um repositório Git mínimo e pede tarefas inofensivas.
//
// Uso: AZIGATE_REAL_AGENTS=1 npm run test:agents:real -- [--provider codex|claude|agy]... [--capture <dir>]
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgyAgentProvider } from '../../src/agents/agy/agy-provider.js'
import { ClaudeAgentProvider } from '../../src/agents/claude/claude-provider.js'
import { CodexAgentProvider } from '../../src/agents/codex/codex-provider.js'
import type { AgentEventDraft } from '../../src/agents/core/agent-event.js'
import type { AgentProvider, AgentProviderId, AgentRuntimeSession, AgentSessionContext } from '../../src/agents/core/agent-provider.js'
import { CERTIFIED_VERSIONS } from '../../src/agents/core/versions.js'

if (process.env.AZIGATE_REAL_AGENTS !== '1') {
  console.error('Suíte real desativada. Defina AZIGATE_REAL_AGENTS=1 para consumir cota das CLIs conscientemente.')
  process.exit(2)
}

const args = process.argv.slice(2)
const selected: AgentProviderId[] = []
let captureDir: string | undefined
for (let index = 0; index < args.length; index += 2) {
  const value = args[index + 1]
  if (args[index] === '--provider' && (value === 'codex' || value === 'claude' || value === 'agy')) selected.push(value)
  else if (args[index] === '--capture' && value) captureDir = resolve(value)
  else {
    console.error(`Argumento inválido: ${args[index] ?? ''}`)
    process.exit(2)
  }
}

const inspectionCwd = realpathSync(mkdtempSync(join(tmpdir(), 'azigate-real-inspect-')))
const providers: Record<AgentProviderId, AgentProvider> = {
  codex: new CodexAgentProvider({ binary: process.env.CODEX_BINARY ?? 'codex', inspectionCwd, requestTimeoutMs: 60_000 }),
  claude: new ClaudeAgentProvider({ binary: process.env.CLAUDE_BINARY ?? 'claude', inspectionCwd }),
  agy: new AgyAgentProvider({ binary: process.env.AGY_BINARY ?? 'agy', inspectionCwd, initTimeoutMs: 60_000 }),
}

function createWorkspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'azigate-real-workspace-')))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'azigate-real', private: true, scripts: { test: 'node teste.js' } }, null, 2))
  writeFileSync(join(root, 'teste.js'), "const fs = require('node:fs')\nif (fs.readFileSync('hello.txt', 'utf8').trim() !== 'oi azigate') process.exit(1)\nconsole.log('ok')\n")
  const git = (...gitArgs: string[]): void => {
    execFileSync('git', gitArgs, { cwd: root, stdio: 'ignore' })
  }
  git('init', '-q')
  git('-c', 'user.email=azigate@example.invalid', '-c', 'user.name=azigate', 'add', '.')
  git('-c', 'user.email=azigate@example.invalid', '-c', 'user.name=azigate', 'commit', '-q', '-m', 'inicial')
  return root
}

function context(provider: AgentProviderId, approvals: string[]): AgentSessionContext {
  return {
    // Aprovação automática aceitável só aqui: o workspace é temporário e descartável.
    requestApproval: async (request) => {
      approvals.push(`${request.tool}: ${request.summary}`)
      return 'allow'
    },
    emit: (event) => capture(provider, event),
    diagnostic: () => undefined,
  }
}

function capture(provider: AgentProviderId, event: AgentEventDraft): void {
  if (!captureDir || event.native === undefined) return
  mkdirSync(captureDir, { recursive: true })
  appendFileSync(join(captureDir, `${provider}.jsonl`), `${JSON.stringify(event.native)}\n`)
}

async function turn(provider: AgentProviderId, session: AgentRuntimeSession, text: string): Promise<AgentEventDraft[]> {
  const events: AgentEventDraft[] = []
  for await (const event of session.startTurn({ turnId: `real_${Date.now()}`, text })) {
    capture(provider, event)
    events.push(event)
  }
  return events
}

const TASK =
  'No diretório atual, crie o arquivo hello.txt com o texto "ola azigate". Depois leia o arquivo, troque "ola" por "oi", ' +
  'rode git diff e rode npm test. Não altere nenhum outro arquivo. Ao terminar responda apenas OK.'

let failures = 0
const ids = selected.length > 0 ? selected : (['codex', 'claude', 'agy'] as const)
for (const id of ids) {
  const provider = providers[id]
  const health = await provider.health()
  if (!health.installed) {
    console.log(JSON.stringify({ provider: id, skipped: 'não instalado' }))
    continue
  }
  const root = createWorkspace()
  const approvals: string[] = []
  const options = { sessionId: `agt_real_${id}`, workspace: { kind: 'local' as const, id: 'real', root }, sessionDir: root, permissionMode: 'acceptEdits' as const }
  const report: Record<string, unknown> = { provider: id, version: health.version, certified: CERTIFIED_VERSIONS[id].includes(health.version ?? ''), workspace: root }
  try {
    const session = await provider.createSession(options, context(id, approvals))
    const first = await turn(id, session, TASK)
    const content = readFileSync(join(root, 'hello.txt'), 'utf8').trim()
    execFileSync('npm', ['test', '--silent'], { cwd: root, stdio: 'ignore' })
    const nativeId = session.nativeSessionId
    await session.close()
    if (!nativeId) throw new Error('sessão sem identificador nativo')
    const resumed = await provider.resumeSession(nativeId, options, context(id, approvals))
    const second = await turn(id, resumed, 'Qual é o conteúdo atual de hello.txt? Responda só o conteúdo.')
    await resumed.close()
    Object.assign(report, {
      ok: first.at(-1)?.event === 'turn.completed' && content === 'oi azigate' && second.at(-1)?.event === 'turn.completed',
      fileContent: content,
      firstTurn: first.map((event) => event.event).filter((event, index, all) => all.indexOf(event) === index),
      toolEvents: first.filter((event) => event.event === 'tool.started').length,
      approvals: approvals.length,
      resumedAnswer: second.at(-1)?.output,
    })
  } catch (error) {
    Object.assign(report, { ok: false, error: error instanceof Error ? error.message : 'erro desconhecido' })
  }
  if (report.ok !== true) failures += 1
  console.log(JSON.stringify(report, null, 2))
}
process.exit(failures === 0 ? 0 : 1)
