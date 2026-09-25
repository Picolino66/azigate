import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createAgentdApp, type AgentdRuntime } from '../src/agentd/app.js'
import { loadAgentdConfig, type AgentdConfig } from '../src/agentd/config.js'
import type { AgentProvider, AgentProviderId } from '../src/agents/core/agent-provider.js'
import { MemorySessionStore } from '../src/agent-control/session-store.js'
import { AgentdSocketClient } from '../src/mcp-bridge/socket-client.js'
import { signWorkerToken } from '../src/worker-protocol/security.js'
import { WorkerClient } from '../src/worker/client.js'
import { WorkerHandler } from '../src/worker/handler.js'
import { tempDir } from './helpers/agents.js'
import { ScriptedProvider, flush } from './helpers/scripted-provider.js'

const AGENT_KEY = 'chave-do-agent-plane-0001'
const OTHER_KEY = 'outra-chave-do-agent-plane'
const MODEL_KEY = 'chave-do-model-plane-0001'
const SECRET = 'segredo-de-worker-com-mais-de-32-caracteres'
const auth = { authorization: `Bearer ${AGENT_KEY}` }

interface Harness {
  runtime: AgentdRuntime
  app: FastifyInstance
  claude: ScriptedProvider
  config: AgentdConfig
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function harness(env: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const config = loadAgentdConfig({
    AGENT_GATEWAY_ENABLED: 'true',
    AGENT_API_KEYS: `${AGENT_KEY},${OTHER_KEY}`,
    GATEWAY_API_KEYS: MODEL_KEY,
    AGENT_DATA_DIR: tempDir('azg-'),
    CLAUDE_AGENT_ENABLED: 'true',
    AGY_AGENT_ENABLED: 'true',
    WORKER_ENABLED: 'true',
    WORKER_TOKEN_SECRET: SECRET,
    WORKER_HEARTBEAT_INTERVAL: '1s',
    AGENT_MAX_REQUEST_BODY_BYTES: '2048',
    ...env,
  })
  const claude = new ScriptedProvider('claude', true)
  const providers = new Map<AgentProviderId, AgentProvider>([
    ['codex', new ScriptedProvider('codex')],
    ['claude', claude],
    ['agy', new ScriptedProvider('agy')],
  ])
  const runtime = await createAgentdApp(config, {
    logger: pino({ level: 'silent' }),
    store: new MemorySessionStore(),
    providers,
    localWorkspaces: new Map([['backend', tempDir()]]),
    mcpBridge: { command: process.execPath, args: ['/opt/azigate/dist/mcp-bridge/main.js'] },
  })
  cleanups.push(() => runtime.app.close())
  return { runtime, app: runtime.app, claude, config }
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('endereço inválido')
  return `127.0.0.1:${address.port}`
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condição não satisfeita a tempo')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function httpStatus(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0)))
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', resolve))
}

describe('agentd — superfície HTTP', () => {
  it('expõe health/ready públicos e exige credencial do Agent Plane', async () => {
    const { app } = await harness()
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok', service: 'azigate-agentd' })
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200)

    const missing = await app.inject({ method: 'GET', url: '/agent/v1/providers' })
    expect(missing.statusCode).toBe(401)
    expect(missing.json()).toEqual({ error: { message: 'Credencial do Agent Plane ausente ou inválida', type: 'agent_error', code: 'invalid_agent_key' } })
    const modelKey = await app.inject({ method: 'GET', url: '/agent/v1/providers', headers: { authorization: `Bearer ${MODEL_KEY}` } })
    expect(modelKey.statusCode).toBe(401)
    const workerToken = signWorkerToken(SECRET, { workerId: 'devbox', workspaces: ['backend'], ttlSeconds: 60 })
    expect((await app.inject({ method: 'GET', url: '/agent/v1/providers', headers: { authorization: `Bearer ${workerToken}` } })).statusCode).toBe(401)

    const providers = await app.inject({ method: 'GET', url: '/agent/v1/providers', headers: auth })
    expect(providers.json()).toMatchObject({
      codex: { enabled: false, available: false },
      claude: { enabled: true, installed: true, version: '9.9.9', certified: false, available: true, remoteWorkspace: true },
      agy: { enabled: true, available: true },
    })
    expect((await app.inject({ method: 'GET', url: '/agent/v1/workers', headers: auth })).json()).toEqual({ data: [] })
    expect((await app.inject({ method: 'GET', url: '/v1/chat/completions', headers: auth })).json()).toMatchObject({ error: { code: 'route_not_found' } })
  })

  it('não fica pronto sem provider disponível e aplica allowlist de IP e rate limit', async () => {
    const closed = await harness({ CLAUDE_AGENT_ENABLED: 'false', AGY_AGENT_ENABLED: 'false' })
    expect((await closed.app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503)

    const restricted = await harness({ AGENT_ALLOWED_IPS: '10.0.0.1' })
    const blocked = await restricted.app.inject({ method: 'GET', url: '/agent/v1/workers', headers: auth })
    expect(blocked.statusCode).toBe(403)
    expect(blocked.json()).toMatchObject({ error: { code: 'ip_not_allowed' } })

    const limited = await harness({ AGENT_RATE_LIMIT_MAX: '1' })
    expect((await limited.app.inject({ method: 'GET', url: '/agent/v1/workers', headers: auth })).statusCode).toBe(200)
    const second = await limited.app.inject({ method: 'GET', url: '/agent/v1/workers', headers: auth })
    expect(second.statusCode).toBe(429)
    expect(second.headers['retry-after']).toBeDefined()
  })

  it('conduz o ciclo de vida da sessão com isolamento por credencial', async () => {
    const { app, claude } = await harness()
    const created = await app.inject({
      method: 'POST',
      url: '/agent/v1/sessions',
      headers: auth,
      payload: { provider: 'claude', workspace: 'backend', permissionMode: 'plan' },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ status: 'ready', permissionMode: 'plan', nativeSessionId: 'native-1' })
    const { id } = created.json<{ id: string }>()

    const other = { authorization: `Bearer ${OTHER_KEY}` }
    expect((await app.inject({ method: 'GET', url: `/agent/v1/sessions/${id}`, headers: other })).statusCode).toBe(404)

    const turn = await app.inject({ method: 'POST', url: `/agent/v1/sessions/${id}/turns`, headers: auth, payload: { input: 'analise' } })
    expect(turn.statusCode).toBe(202)
    const approval = claude.last.context.requestApproval({ tool: 'Bash', summary: 'npm test', native: {} })
    const pending = (await app.inject({ method: 'GET', url: `/agent/v1/sessions/${id}`, headers: auth })).json<{
      pendingApprovals: { id: string }[]
      currentTurn: { status: string }
    }>()
    expect(pending.currentTurn.status).toBe('running')
    const approvalId = pending.pendingApprovals[0]?.id ?? ''
    expect((await app.inject({ method: 'POST', url: `/agent/v1/approvals/${approvalId}`, headers: other, payload: { decision: 'allow' } })).statusCode).toBe(404)
    const decided = await app.inject({ method: 'POST', url: `/agent/v1/approvals/${approvalId}`, headers: auth, payload: { decision: 'allow' } })
    expect(decided.json()).toMatchObject({ status: 'allowed' })
    await expect(approval).resolves.toBe('allow')

    expect((await app.inject({ method: 'POST', url: `/agent/v1/sessions/${id}/cancel`, headers: auth })).statusCode).toBe(202)
    await flush()
    expect((await app.inject({ method: 'POST', url: `/agent/v1/sessions/${id}/cancel`, headers: auth })).statusCode).toBe(409)

    const closed = await app.inject({ method: 'DELETE', url: `/agent/v1/sessions/${id}`, headers: auth })
    expect(closed.json()).toMatchObject({ status: 'closed' })
    const events = await app.inject({ method: 'GET', url: `/agent/v1/sessions/${id}/events`, headers: auth })
    expect(events.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    const names = [...events.body.matchAll(/^event: (.+)$/gmu)].map((match) => match[1])
    expect(names).toEqual(['turn.started', 'approval.required', 'approval.resolved', 'turn.failed', 'session.closed'])
    expect(events.body).toMatch(/^id: 1$/mu)

    const replay = await app.inject({ method: 'GET', url: `/agent/v1/sessions/${id}/events`, headers: { ...auth, 'last-event-id': '3' } })
    expect([...replay.body.matchAll(/^id: (\d+)$/gmu)].map((match) => match[1])).toEqual(['4', '5'])
    expect((await app.inject({ method: 'GET', url: `/agent/v1/sessions/${id}/events?after=abc`, headers: auth })).statusCode).toBe(400)
  })

  it('traduz erros de corpo e de rota para o formato do Agent Plane', async () => {
    const { app } = await harness()
    const tooLarge = await app.inject({ method: 'POST', url: '/agent/v1/sessions', headers: auth, payload: { provider: 'claude', workspace: 'x'.repeat(4000) } })
    expect(tooLarge.statusCode).toBe(413)
    const invalid = await app.inject({ method: 'POST', url: '/agent/v1/sessions', headers: { ...auth, 'content-type': 'application/json' }, payload: '{' })
    expect(invalid.json()).toMatchObject({ error: { code: 'invalid_json' } })
    const media = await app.inject({ method: 'POST', url: '/agent/v1/sessions', headers: { ...auth, 'content-type': 'application/xml' }, payload: '<x/>' })
    expect(media.statusCode).toBe(415)
    const text = await app.inject({ method: 'POST', url: '/agent/v1/sessions', headers: { ...auth, 'content-type': 'text/plain' }, payload: 'x' })
    expect(text.json()).toMatchObject({ error: { code: 'invalid_request' } })
    const unknownSession = await app.inject({
      method: 'POST',
      url: '/agent/v1/sessions/agt_000000000000000000000000/turns',
      headers: auth,
      payload: { input: 'x' },
    })
    expect(unknownSession.json()).toMatchObject({ error: { code: 'session_not_found' } })
    const badWorker = await app.inject({ method: 'POST', url: '/agent/v1/sessions', headers: auth, payload: { provider: 'claude', workspace: 'backend', worker: 'devbox' } })
    expect(badWorker.json()).toMatchObject({ error: { code: 'worker_unavailable' } })
  })
})

describe('agentd — tempo real, worker remoto e ponte MCP', () => {
  it('transmite eventos ao vivo por SSE e pelo WebSocket nativo somente de saída', async () => {
    const { app, claude } = await harness()
    const host = await listen(app)
    const json = { ...auth, 'content-type': 'application/json' }
    const created = await fetch(`http://${host}/agent/v1/sessions`, { method: 'POST', headers: json, body: JSON.stringify({ provider: 'claude', workspace: 'backend' }) })
    const { id } = (await created.json()) as { id: string }

    const stream = await fetch(`http://${host}/agent/v1/sessions/${id}/events`, { headers: auth })
    const reader = stream.body?.getReader()
    if (!reader) throw new Error('sem corpo')
    const nativeMessages: unknown[] = []
    const native = new WebSocket(`ws://${host}/native/claude/${id}`, { headers: auth })
    native.on('message', (data: Buffer) => nativeMessages.push(JSON.parse(data.toString('utf8'))))
    await new Promise((resolve) => native.once('open', resolve))
    native.send('{"method":"command/exec","params":{"command":["id"]}}')

    await fetch(`http://${host}/agent/v1/sessions/${id}/turns`, { method: 'POST', headers: json, body: JSON.stringify({ input: 'olá' }) })
    await flush()
    claude.last.push({ event: 'message.delta', text: 'ao vivo', native: { type: 'stream_event' } })
    claude.last.push({ event: 'turn.completed', output: 'ao vivo', native: { type: 'result' } })

    let received = ''
    while (!received.includes('turn.completed')) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += Buffer.from(chunk.value).toString('utf8')
    }
    expect(received).toContain('event: message.delta')
    expect(received).toContain('"text":"ao vivo"')
    await waitFor(() => nativeMessages.length >= 2)
    expect(nativeMessages).toEqual([
      { id: 2, event: 'message.delta', native: { type: 'stream_event' } },
      { id: 3, event: 'turn.completed', native: { type: 'result' } },
    ])
    // A mensagem enviada pelo cliente no endpoint nativo nunca vira turno nem comando.
    expect(claude.last.inputs).toHaveLength(1)

    const closed = closeCode(native)
    await fetch(`http://${host}/agent/v1/sessions/${id}`, { method: 'DELETE', headers: auth })
    expect(await closed).toBe(1000)
    await reader.cancel()

    expect(await closeCode(new WebSocket(`ws://${host}/native/agy/${id}`, { headers: auth }))).toBe(4404)
    expect(await httpStatus(new WebSocket(`ws://${host}/native/claude/${id}`))).toBe(401)
  })

  it('conecta o worker, recusa credencial errada e executa ferramentas remotas via ponte MCP', async () => {
    const { app, runtime, claude, config } = await harness()
    const host = await listen(app)
    const workspaceRoot = tempDir()
    writeFileSync(join(workspaceRoot, 'README.md'), 'projeto remoto\n')

    expect(await httpStatus(new WebSocket(`ws://${host}/worker/v1/connect`, { headers: auth }))).toBe(401)

    const token = signWorkerToken(SECRET, { workerId: 'devbox', workspaces: ['backend'], ttlSeconds: 60 })
    const logs: string[] = []
    const client = new WorkerClient({
      url: new URL(`ws://${host}/worker/v1/connect`),
      workerId: 'devbox',
      token: () => token,
      handler: new WorkerHandler(new Map([['backend', workspaceRoot], ['privado', tempDir()]]), { enabled: false }),
      version: 'teste',
      log: (event) => logs.push(event),
    })
    client.start()
    cleanups.push(() => client.stop())
    await waitFor(() => logs.includes('worker_registered'))

    const workers = (await app.inject({ method: 'GET', url: '/agent/v1/workers', headers: auth })).json<{ data: unknown[] }>()
    expect(workers.data).toEqual([expect.objectContaining({ id: 'devbox', workspaces: ['backend'], capabilities: ['filesystem', 'git'] })])
    await expect(runtime.workers?.call('devbox', 'backend', 'read_file', { path: '../fora' }, 2000)).rejects.toMatchObject({
      code: 'path_outside_workspace',
    })

    const created = await app.inject({
      method: 'POST',
      url: '/agent/v1/sessions',
      headers: auth,
      payload: { provider: 'claude', workspace: 'backend', worker: 'devbox', permissionMode: 'plan' },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ worker: 'devbox', workspace: 'backend' })
    const options = claude.last.options
    if (options.workspace.kind !== 'remote') throw new Error('esperava workspace remoto')
    expect(options.workspace.allowedTools).toContain('mcp__azigate_workspace__read_file')
    expect(statSync(options.workspace.mcpConfigPath).mode & 0o777).toBe(0o600)
    expect(statSync(options.sessionDir).mode & 0o777).toBe(0o700)
    const mcpConfig = JSON.parse(readFileSync(options.workspace.mcpConfigPath, 'utf8')) as {
      mcpServers: { azigate_workspace: { command: string; args: string[]; env: Record<string, string> } }
    }
    const server = mcpConfig.mcpServers.azigate_workspace
    expect(server.args).toEqual(['/opt/azigate/dist/mcp-bridge/main.js'])
    expect(server.env.AZIGATE_MCP_SOCKET).toBe(config.mcpSocketPath)
    expect(statSync(config.mcpSocketPath).mode & 0o777).toBe(0o600)

    const bridge = new AgentdSocketClient(config.mcpSocketPath, server.env.AZIGATE_MCP_TOKEN ?? '')
    cleanups.push(() => bridge.close())
    expect(await bridge.call('read_file', { path: 'README.md' })).toEqual({
      ok: true,
      result: { content: 'projeto remoto\n', totalBytes: 15, truncated: false },
    })
    expect(await bridge.call('write_file', { path: 'x', content: 'y' })).toMatchObject({ ok: false, code: 'permission_denied' })
    const forged = new AgentdSocketClient(config.mcpSocketPath, 'token-falso')
    cleanups.push(() => forged.close())
    expect(await forged.call('read_file', { path: 'README.md' })).toMatchObject({ ok: false, code: 'permission_denied' })

    await app.inject({ method: 'DELETE', url: `/agent/v1/sessions/${created.json<{ id: string }>().id}`, headers: auth })
    expect(await bridge.call('read_file', { path: 'README.md' })).toMatchObject({ ok: false, code: 'permission_denied' })

    const impostorToken = signWorkerToken(SECRET, { workerId: 'impostor', workspaces: ['backend'], ttlSeconds: 60 })
    const impostor = new WebSocket(`ws://${host}/worker/v1/connect`, { headers: { authorization: `Bearer ${impostorToken}` } })
    await new Promise((resolve) => impostor.once('open', resolve))
    const rejected = closeCode(impostor)
    impostor.send(JSON.stringify({ type: 'worker.register', protocolVersion: 1, workerId: 'devbox', workerVersion: 'x', capabilities: [], workspaces: ['backend'] }))
    expect(await rejected).toBe(4403)
  })
})
