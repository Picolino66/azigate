// Validação REAL e manual do workspace remoto (npm run test:agents:remote-real). Consome cota.
//
// Sobe o azigate-agentd com Codex, Claude Code e AGY reais ("máquina A") e um Workspace Server
// em processo separado sobre um repositório temporário ("máquina B") que contém um código
// aleatório inexistente em A. Cada agente precisa ler o código em B, criar um arquivo em B,
// rodar git status em B e, no segundo turno, lembrar o código (contexto da sessão nativa).
//
// Uso: AZIGATE_REAL_AGENTS=1 npm run test:agents:remote-real -- [--provider claude|codex|agy]...
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import { createAgentdApp } from '../../src/agentd/app.js'
import { loadAgentdConfig } from '../../src/agentd/config.js'
import type { AgentEvent } from '../../src/agents/core/agent-event.js'
import { MemorySessionStore } from '../../src/agent-control/session-store.js'
import { GatewayAuthenticator } from '../../src/security/auth.js'
import { signWorkerToken } from '../../src/workspace/security/token.js'

if (process.env.AZIGATE_REAL_AGENTS !== '1') {
  console.error('Validação real desativada. Defina AZIGATE_REAL_AGENTS=1 para consumir cota das CLIs conscientemente.')
  process.exit(2)
}

type Provider = 'claude' | 'codex' | 'agy'
const args = process.argv.slice(2)
const selected: Provider[] = []
for (let index = 0; index < args.length; index += 2) {
  const value = args[index + 1]
  if (args[index] === '--provider' && (value === 'claude' || value === 'codex' || value === 'agy')) selected.push(value)
}
const providers: Provider[] = selected.length > 0 ? selected : ['claude', 'codex', 'agy']
const MODELS: Record<Provider, string | undefined> = {
  claude: process.env.CLAUDE_MODEL ?? 'sonnet',
  codex: process.env.CODEX_MODEL,
  agy: process.env.AGY_MODEL ?? 'gemini-3.8-flash-high',
}

const temp = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)))
const KEY = randomBytes(24).toString('hex')
const SECRET = randomBytes(32).toString('hex')
const CODE = `AZG-${randomBytes(4).toString('hex').toUpperCase()}`

// Máquina B: repositório com a fixture.
const rootB = join(temp('azigate-real-b-'), 'meu-projeto')
mkdirSync(rootB)
writeFileSync(join(rootB, 'fixture-b.txt'), `codigo: ${CODE}\n`)
writeFileSync(join(rootB, 'package.json'), JSON.stringify({ name: 'projeto-b', private: true }))
for (const gitArgs of [['init', '-q'], ['add', '.'], ['-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'inicial']]) {
  execFileSync('git', gitArgs, { cwd: rootB, stdio: 'ignore' })
}

const config = loadAgentdConfig({
  NODE_ENV: 'development',
  AGENT_GATEWAY_ENABLED: 'true',
  AGENT_API_KEYS: KEY,
  AGENT_DATA_DIR: temp('azigate-real-a-'),
  CLAUDE_AGENT_ENABLED: String(providers.includes('claude')),
  CODEX_AGENT_ENABLED: String(providers.includes('codex')),
  AGY_AGENT_ENABLED: String(providers.includes('agy')),
  WORKER_ENABLED: 'true',
  WORKER_TOKEN_SECRET: SECRET,
  AGENT_VERSION_POLICY: 'warn',
  AGENT_RATE_LIMIT_MAX: '100000',
  AGENT_RATE_LIMIT_IP_MAX: '100000',
})
// Máquina A: nenhuma cópia do projeto (sem workspaces locais).
const runtime = await createAgentdApp(config, { logger: pino({ level: 'warn' }), store: new MemorySessionStore(), localWorkspaces: new Map() })
await runtime.app.listen({ host: '127.0.0.1', port: 0 })
const address = runtime.app.server.address()
if (!address || typeof address === 'string') throw new Error('endereço inválido')
const base = `http://127.0.0.1:${address.port}`
const owner = new GatewayAuthenticator([KEY]).verify(`Bearer ${KEY}`) ?? ''

const serverDir = temp('azigate-real-b-server-')
writeFileSync(join(serverDir, 'token'), signWorkerToken(SECRET, { workerId: 'maquina-b', workspaces: ['meu-projeto'], ttlSeconds: 3600 }), { mode: 0o600 })
writeFileSync(
  join(serverDir, 'workspace.json'),
  JSON.stringify({ gateway: base, workerId: 'maquina-b', tokenFile: 'token', workspaces: { 'meu-projeto': { path: rootB } }, exec: { enabled: true, allowedCommands: ['git', 'node'] } }),
)
const workspaceServer = spawn(
  process.execPath,
  ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../../src/workspace/server/main.ts', import.meta.url)), '--config', join(serverDir, 'workspace.json')],
  { cwd: serverDir, env: { PATH: process.env.PATH ?? '', HOME: serverDir }, stdio: 'ignore' },
)

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? { authorization: `Bearer ${KEY}` } : { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: (await response.json()) as T }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

async function turn(sessionId: string, input: string, approvals: string[]): Promise<AgentEvent[]> {
  const accepted = await api<{ turnId: string }>('POST', `/agent/v1/sessions/${sessionId}/turns`, { input })
  const events = (): AgentEvent[] => runtime.sessions.events(owner, sessionId).since(0).filter((event) => event.turnId === accepted.body.turnId)
  await waitFor(async () => {
    const session = await api<{ pendingApprovals: { id: string; tool: string; summary: string }[] }>('GET', `/agent/v1/sessions/${sessionId}`)
    for (const approval of session.body.pendingApprovals ?? []) {
      approvals.push(`${approval.tool}: ${approval.summary}`)
      await api('POST', `/agent/v1/approvals/${approval.id}`, { decision: 'allow' })
    }
    return events().some((event) => event.event === 'turn.completed' || event.event === 'turn.failed')
  }, 300_000)
  return events()
}

let failures = 0
try {
  const connected = await waitFor(async () => (await api<{ data: unknown[] }>('GET', '/agent/v1/workers')).body.data.length > 0, 30_000)
  if (!connected) throw new Error('o Workspace Server não conectou')
  for (const provider of providers) {
    const report: Record<string, unknown> = { provider, code: CODE }
    const approvals: string[] = []
    try {
      const created = await api<{ id: string; providerVersion: string; error?: unknown }>('POST', '/agent/v1/sessions', {
        provider,
        worker: 'maquina-b',
        workspace: 'meu-projeto',
        permissionMode: 'review',
        ...(MODELS[provider] ? { model: MODELS[provider] } : {}),
      })
      if (created.status !== 201) throw new Error(`criação falhou: ${JSON.stringify(created.body)}`)
      const sessionId = created.body.id
      const sessionDir = join(config.dataDir, 'sessions', sessionId)
      const answerFile = `resposta-${provider}.txt`
      const first = await turn(
        sessionId,
        'Você está trabalhando em um projeto remoto pelas ferramentas do servidor azigate_workspace. ' +
          `1) Leia o arquivo fixture-b.txt. 2) Crie o arquivo ${answerFile} contendo exatamente o código que aparece nele. ` +
          '3) Rode git_status. Responda em uma linha curta com o código e o resultado do git status.',
        approvals,
      )
      const second = await turn(sessionId, 'Qual era o código do arquivo fixture-b.txt? Responda só com o código, sem usar ferramentas.', approvals)
      const tools = first.filter((event) => event.event === 'tool.started').map((event) => `${event.tool}${event.summary ? ` ${event.summary}` : ''}`)
      Object.assign(report, {
        providerVersion: created.body.providerVersion,
        firstTurn: first.at(-1)?.event,
        firstError: first.find((event) => event.event === 'turn.failed')?.error,
        // Diagnóstico: mensagem nativa do erro (turn.error do Codex, result do Claude/AGY).
        nativeErrors: first
          .filter((event) => event.event === 'turn.failed' || (event.event === 'provider.event' && JSON.stringify(event.native).includes('"error"')))
          .map((event) => JSON.stringify(event.native).slice(0, 600)),
        tools,
        approvals,
        answerFileInB: existsSync(join(rootB, answerFile)) ? readFileSync(join(rootB, answerFile), 'utf8').trim() : null,
        fixtureInA: existsSync(join(sessionDir, 'fixture-b.txt')),
        answerFileInA: existsSync(join(sessionDir, answerFile)),
        firstOutput: first.find((event) => event.event === 'turn.completed')?.output?.slice(0, 400),
        secondOutput: second.find((event) => event.event === 'turn.completed')?.output?.slice(0, 200),
      })
      report.ok =
        report.answerFileInB === CODE &&
        report.fixtureInA === false &&
        report.answerFileInA === false &&
        tools.some((tool) => tool.includes('azigate_workspace__read_file')) &&
        typeof report.secondOutput === 'string' &&
        report.secondOutput.includes(CODE)
      await api('DELETE', `/agent/v1/sessions/${sessionId}`)
    } catch (error) {
      Object.assign(report, { ok: false, error: error instanceof Error ? error.message : 'erro desconhecido' })
    }
    if (report.ok !== true) failures += 1
    console.log(JSON.stringify(report, null, 2))
  }
} finally {
  workspaceServer.kill('SIGTERM')
  await runtime.app.close()
}
process.exit(failures === 0 ? 0 : 1)
