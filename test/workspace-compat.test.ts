// Suíte comum de compatibilidade do workspace remoto (ADR-025).
//
// Prova "agent runtime host = A, workspace host = B" sem mocks de interface:
// - A: azigate-agentd real, com os adaptadores reais iniciando CLIs (falsas) que leem a
//   configuração MCP pelo mecanismo nativo de cada uma e iniciam a ponte MCP real;
// - B: o pacote azigate-client EMPACOTADO (o mesmo `npm install -g` da máquina B), configurado
//   pelo bloco do `client:setup` executado no bash e iniciado sem flags, em OUTRO processo, com
//   raiz própria que contém uma fixture que não existe em A, conectado de saída por WebSocket.
// O mesmo cenário roda para claude, codex e agy.
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAgentdApp, type AgentdRuntime } from '../src/agentd/app.js'
import { buildClientSetupScript } from '../src/agentd/client-setup.js'
import { loadAgentdConfig, type AgentdConfig } from '../src/agentd/config.js'
import { defaultMcpBridgeLaunch } from '../src/agentd/mcp-bridge-launch.js'
import { AgyAgentProvider } from '../src/agents/agy/agy-provider.js'
import { agyRemoteStatus } from '../src/agents/agy/agy-remote-setup.js'
import { ClaudeAgentProvider } from '../src/agents/claude/claude-provider.js'
import { CodexAgentProvider } from '../src/agents/codex/codex-provider.js'
import type { AgentEvent } from '../src/agents/core/agent-event.js'
import type { AgentProvider, AgentProviderId } from '../src/agents/core/agent-provider.js'
import { MemorySessionStore } from '../src/agent-control/session-store.js'
import { GatewayAuthenticator } from '../src/security/auth.js'
import { signWorkerToken } from '../src/workspace/security/token.js'
import { buildClientPackage } from '../tools/client-package.js'
import { fakeBinary, tempDir } from './helpers/agents.js'

const KEY = 'chave-do-agent-plane-compat-01'
const SECRET = 'segredo-de-worker-compat-com-mais-de-32-caracteres'
const FIXTURE = 'SEGREDO-B: conteúdo original que só existe na máquina B'
const auth = { authorization: `Bearer ${KEY}` }
const owner = new GatewayAuthenticator([KEY]).verify(`Bearer ${KEY}`) ?? ''

let runtime: AgentdRuntime
let config: AgentdConfig
let base = ''
let rootB = ''
let homeA = ''
let homeB = ''
let clientBin = ''
let workspaceServer: ChildProcess | undefined

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? auth : { ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: (await response.json()) as T }
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now()
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error('condição não satisfeita a tempo')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Envia um turno e responde às aprovações até o fim; devolve os eventos do turno. */
async function turn(sessionId: string, steps: unknown[], decide: 'allow' | 'deny' = 'allow'): Promise<AgentEvent[]> {
  const accepted = await api<{ turnId: string }>('POST', `/agent/v1/sessions/${sessionId}/turns`, { input: JSON.stringify(steps) })
  expect(accepted.status).toBe(202)
  const turnId = accepted.body.turnId
  const events = (): AgentEvent[] => runtime.sessions.events(owner, sessionId).since(0).filter((event) => event.turnId === turnId)
  await waitFor(async () => {
    const session = await api<{ pendingApprovals: { id: string }[] }>('GET', `/agent/v1/sessions/${sessionId}`)
    for (const approval of session.body.pendingApprovals) {
      await api('POST', `/agent/v1/approvals/${approval.id}`, { decision: decide })
    }
    return events().some((event) => event.event === 'turn.completed' || event.event === 'turn.failed')
  }, 45_000)
  return events()
}

function output(events: AgentEvent[]): string {
  return events.find((event) => event.event === 'turn.completed')?.output ?? ''
}

beforeAll(async () => {
  homeA = tempDir('azc-home-a-')
  const env = { ...process.env, HOME: homeA }
  config = loadAgentdConfig({
    NODE_ENV: 'test',
    AGENT_GATEWAY_ENABLED: 'true',
    AGENT_API_KEYS: KEY,
    AGENT_DATA_DIR: tempDir('azc-a-'),
    CLAUDE_AGENT_ENABLED: 'true',
    CODEX_AGENT_ENABLED: 'true',
    AGY_AGENT_ENABLED: 'true',
    WORKER_ENABLED: 'true',
    WORKER_TOKEN_SECRET: SECRET,
    AGENT_VERSION_POLICY: 'fail-closed',
    // A preparação do AGY roda com o binário falso, nunca com a CLI real.
    AGY_BINARY: fakeBinary('fake-agy'),
    AGENT_RATE_LIMIT_MAX: '100000',
    AGENT_RATE_LIMIT_IP_MAX: '100000',
  })
  const inspectionCwd = tempDir()
  const providers = new Map<AgentProviderId, AgentProvider>([
    ['claude', new ClaudeAgentProvider({ binary: fakeBinary('fake-claude'), inspectionCwd, env, interruptGraceMs: 3000 })],
    ['codex', new CodexAgentProvider({ binary: fakeBinary('fake-codex'), inspectionCwd, env, requestTimeoutMs: 10_000 })],
    ['agy', new AgyAgentProvider({ binary: fakeBinary('fake-agy'), inspectionCwd, env, interruptGraceMs: 3000 })],
  ])
  runtime = await createAgentdApp(config, {
    logger: pino({ level: 'silent' }),
    store: new MemorySessionStore(),
    providers,
    // A máquina A não tem nenhuma cópia do projeto.
    localWorkspaces: new Map(),
    mcpBridge: defaultMcpBridgeLaunch(),
    home: homeA,
  })
  await runtime.app.listen({ host: '127.0.0.1', port: 0 })
  const address = runtime.app.server.address()
  if (!address || typeof address === 'string') throw new Error('endereço inválido')
  base = `http://127.0.0.1:${address.port}`

  // Máquina B: projeto real com Git e uma fixture que A não tem.
  rootB = join(tempDir('azc-b-'), 'meu-projeto')
  mkdirSync(rootB, { recursive: true })
  writeFileSync(join(rootB, 'package.json'), JSON.stringify({ name: 'projeto-b', scripts: { test: 'node -e 0' } }))
  writeFileSync(join(rootB, 'fixture-b.txt'), `${FIXTURE}\n`)
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: rootB, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
  }
  git('init', '-q')
  git('-c', 'user.email=b@b', '-c', 'user.name=b', 'add', '.')
  git('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'inicial')
  // Pacote da máquina B e configuração pelo bloco que o operador cola na B.
  clientBin = join(await buildClientPackage(tempDir('azc-pkg-')), 'bin')
  homeB = tempDir('azc-home-b-')
  const setup = buildClientSetupScript(
    { workerId: 'maquina-b', workspaces: new Map([['meu-projeto', rootB]]), gateway: base, days: 1, allowedCommands: ['node', 'git'], withAgentKey: true },
    { workspaceToken: signWorkerToken(SECRET, { workerId: 'maquina-b', workspaces: ['meu-projeto'], ttlSeconds: 600 }), agentKey: KEY },
  )
  execFileSync('bash', ['-c', setup], { cwd: homeB, env: { PATH: process.env.PATH ?? '', HOME: homeB }, stdio: 'ignore' })
  workspaceServer = spawn(process.execPath, [join(clientBin, 'azigate-workspace.mjs')], {
    cwd: homeB,
    env: { PATH: process.env.PATH ?? '', HOME: homeB },
    stdio: 'ignore',
  })
  await waitFor(async () => (await api<{ data: { id: string }[] }>('GET', '/agent/v1/workers')).body.data.some((worker) => worker.id === 'maquina-b'))
}, 60_000)

afterAll(async () => {
  workspaceServer?.kill('SIGTERM')
  await runtime.app.close()
})

describe('preparação da máquina A', () => {
  it('prepara o AGY para workspace remoto sem tocar em nada fora do Azigate', () => {
    expect(agyRemoteStatus(homeA)).toEqual({ mcpRegistered: true, agentInstalled: true, permissionsGranted: true, ready: true })
  })

  it('publica os três providers com workspace remoto e o Workspace Server com MCP', async () => {
    const providers = await api<Record<string, { available: boolean; remoteWorkspace: boolean; certified: boolean }>>('GET', '/agent/v1/providers')
    for (const id of ['claude', 'codex', 'agy']) {
      expect(providers.body[id]).toMatchObject({ available: true, remoteWorkspace: true, certified: true })
    }
    const workers = await api<{ data: { id: string; capabilities: string[]; workspaces: string[] }[] }>('GET', '/agent/v1/workers')
    expect(workers.body.data[0]).toMatchObject({ id: 'maquina-b', workspaces: ['meu-projeto'] })
    expect(workers.body.data[0]?.capabilities).toEqual(expect.arrayContaining(['filesystem', 'git', 'exec', 'mcp']))
  })

  it('configura a máquina B só com o bloco do client:setup: arquivos privados e cliente sem variáveis de ambiente', async () => {
    const dir = join(homeB, '.config', 'azigate')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    for (const file of ['workspace.token', 'workspace.json', 'agent.json', 'agent.key']) {
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600)
    }
    // Assíncrono: o agentd roda neste mesmo processo e precisa responder.
    const { stdout } = await promisify(execFile)(process.execPath, [join(clientBin, 'azigate-agent.mjs'), 'workers'], {
      cwd: homeB,
      env: { PATH: process.env.PATH ?? '', HOME: homeB },
      timeout: 10_000,
    })
    expect(JSON.parse(stdout)).toMatchObject([{ id: 'maquina-b', workspaces: ['meu-projeto'] }])
  })
})

describe.each(['claude', 'codex', 'agy'] as const)('compatibilidade do workspace remoto — %s', (provider) => {
  it('opera o projeto da máquina B com runtime na máquina A, preservando sessão, aprovações e cancelamento', async () => {
    // 1–2. inicia a sessão ligada ao workspace de B
    const created = await api<{ id: string; status: string; worker: string }>('POST', '/agent/v1/sessions', {
      provider,
      worker: 'maquina-b',
      workspace: 'meu-projeto',
      permissionMode: 'review',
      ...(provider === 'codex' ? { effort: 'medium' } : {}),
    })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ status: 'ready', worker: 'maquina-b' })
    const sessionId = created.body.id
    const sessionDir = join(config.dataDir, 'sessions', sessionId)
    expect(existsSync(join(sessionDir, 'fixture-b.txt'))).toBe(false)

    // 3–13. lista, lê, busca, cria, edita, git status/diff e shell com aprovação
    const created1 = `criado-por-${provider}.txt`
    const steps: unknown[] = [
      { localCheck: 'fixture-b.txt' },
      ...(provider === 'codex' ? [{ nativeCommand: 'cat /etc/hostname' }] : []),
      { call: 'list_directory', args: {} },
      { call: 'read_file', args: { path: 'package.json' } },
      { call: 'search', args: { query: 'SEGREDO-B' } },
      { call: 'read_file', args: { path: 'fixture-b.txt' } },
      { call: 'write_file', args: { path: created1, content: `feito por ${provider} em B` } },
      { call: 'edit_file', args: { path: created1, oldText: 'feito', newText: 'editado' } },
      { call: 'edit_file', args: { path: 'fixture-b.txt', oldText: `inexistente-${provider}`, newText: 'x' } },
      { call: 'git_status', args: {} },
      { call: 'git_diff', args: {} },
      { call: 'shell_exec', args: { argv: ['node', '-e', 'process.stdout.write("cwd=" + process.cwd())'] } },
    ]
    const first = await turn(sessionId, steps)
    const text = output(first)
    expect(first.at(-1)?.event).toBe('turn.completed')
    // o runtime do agente está em A: a fixture não existe no cwd dele
    expect(text).toContain(`local fixture-b.txt: ausente em ${sessionDir}`)
    // …mas ele a leu, alterou e executou em B
    expect(text).toContain(FIXTURE)
    expect(text).toContain(`cwd=${rootB}`)
    expect(readFileSync(join(rootB, created1), 'utf8')).toBe(`editado por ${provider} em B`)
    expect(readFileSync(join(rootB, 'fixture-b.txt'), 'utf8')).toBe(`${FIXTURE}\n`)
    expect(existsSync(join(sessionDir, created1))).toBe(false)
    expect(text).toMatch(/git_status: ok ## (main|master)/u)
    // edição com texto inexistente volta como erro da ferramenta, sem quebrar o turno
    expect(text).toContain('edit_file: erro conflict')
    if (provider === 'codex') expect(text).toContain('nativo: decline')

    const toolNames = new Set(first.filter((event) => event.event === 'tool.started').map((event) => event.tool))
    for (const tool of ['list_directory', 'read_file', 'search', 'write_file', 'edit_file', 'git_status', 'git_diff', 'shell_exec']) {
      expect(toolNames).toContain(`mcp__azigate_workspace__${tool}`)
    }
    const readEvent = first.find((event) => event.event === 'tool.started' && event.tool === 'mcp__azigate_workspace__read_file')
    expect(readEvent?.summary).toBe('package.json')
    // 10–12. shell e escritas geraram aprovações do Azigate (nativas no Claude, no gateway nos demais)
    const approvals = first.filter((event) => event.event === 'approval.required').map((event) => event.tool)
    expect(approvals).toEqual(
      expect.arrayContaining(['mcp__azigate_workspace__write_file', 'mcp__azigate_workspace__edit_file', 'mcp__azigate_workspace__shell_exec']),
    )
    expect(approvals).not.toContain('mcp__azigate_workspace__read_file')

    // negação: nada é escrito em B
    const denied = await turn(sessionId, [{ call: 'write_file', args: { path: `negado-${provider}.txt`, content: 'x' } }], 'deny')
    expect(output(denied)).toMatch(/write_file: (negado|erro permission_denied)/u)
    expect(existsSync(join(rootB, `negado-${provider}.txt`))).toBe(false)

    // 14. o segundo turno preserva o contexto da sessão nativa
    const second = await turn(sessionId, [{ recall: true }])
    expect(output(second)).toContain(`lembro: ${FIXTURE}`)

    // 15. cancelamento
    const accepted = await api<{ turnId: string }>('POST', `/agent/v1/sessions/${sessionId}/turns`, { input: JSON.stringify([{ hang: true }]) })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await api('POST', `/agent/v1/sessions/${sessionId}/cancel`)).status).toBe(202)
    await waitFor(() => runtime.sessions.events(owner, sessionId).since(0).some((event) => event.turnId === accepted.body.turnId && event.event === 'turn.failed'))
    const failed = runtime.sessions.events(owner, sessionId).since(0).find((event) => event.turnId === accepted.body.turnId && event.event === 'turn.failed')
    expect(failed?.error?.code).toBe('turn_cancelled')

    // 16. encerra: diretório privado (e o token da ponte) desaparecem
    const closed = await api<{ status: string }>('DELETE', `/agent/v1/sessions/${sessionId}`)
    expect(closed.body.status).toBe('closed')
    expect(existsSync(sessionDir)).toBe(false)
  }, 90_000)
})

describe('modo plan no workspace remoto', () => {
  it.each(['claude', 'codex', 'agy'] as const)('%s só lê: escrita é recusada pelo Azigate antes de chegar a B', async (provider) => {
    const created = await api<{ id: string }>('POST', '/agent/v1/sessions', { provider, worker: 'maquina-b', workspace: 'meu-projeto', permissionMode: 'plan' })
    const events = await turn(created.body.id, [
      { call: 'read_file', args: { path: 'package.json' } },
      { call: 'write_file', args: { path: `plan-${provider}.txt`, content: 'x' } },
    ])
    expect(output(events)).toContain('read_file: ok')
    expect(output(events)).toContain('write_file: erro permission_denied: O modo plan permite somente leitura')
    expect(existsSync(join(rootB, `plan-${provider}.txt`))).toBe(false)
    // Claude pergunta pela permissão nativa; mesmo aprovada, o relay recusa. Nos demais, nem há pedido.
    if (provider !== 'claude') expect(events.some((event) => event.event === 'approval.required')).toBe(false)
    await api('DELETE', `/agent/v1/sessions/${created.body.id}`)
  }, 60_000)
})
