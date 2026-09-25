import { statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentProvider, AgentProviderId } from '../src/agents/core/agent-provider.js'
import { AgentRegistry } from '../src/agents/core/agent-registry.js'
import { AgentResumeError } from '../src/agents/core/process-session.js'
import { AgentPlaneError } from '../src/agent-control/errors.js'
import { MemorySessionStore, SqliteSessionStore, type SessionRecord } from '../src/agent-control/session-store.js'
import { SessionService, type SessionLimits } from '../src/agent-control/sessions.js'
import { tempDir } from './helpers/agents.js'
import { ScriptedProvider, flush } from './helpers/scripted-provider.js'

const OWNER = 'dono'
const OTHER = 'intruso'

const baseLimits: SessionLimits = {
  maxSessions: 10,
  maxSessionsPerProvider: 4,
  idleTimeoutMs: 60_000,
  turnTimeoutMs: 60_000,
  approvalTimeoutMs: 60_000,
  cancelGraceMs: 60_000,
  eventBufferSize: 100,
  eventBufferBytes: 1024 * 1024,
  maxInputChars: 1000,
  closedRetentionMs: 60_000,
}

interface Harness {
  service: SessionService
  store: MemorySessionStore
  provider: ScriptedProvider
  workspace: string
}

const services: SessionService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
})

function harness(options: { limits?: Partial<SessionLimits>; enabled?: AgentProviderId[]; provider?: ScriptedProvider } = {}): Harness {
  const provider = options.provider ?? new ScriptedProvider('claude', true)
  const agy = new ScriptedProvider('agy')
  const providers = new Map<AgentProviderId, AgentProvider>([
    ['claude', provider],
    ['agy', agy],
  ])
  const registry = new AgentRegistry(providers, new Set(options.enabled ?? ['claude', 'agy']), 'warn')
  const store = new MemorySessionStore()
  const workspace = tempDir()
  const service = new SessionService({
    store,
    registry,
    localWorkspaces: new Map([['backend', workspace]]),
    dataDir: tempDir(),
    limits: { ...baseLimits, ...options.limits },
    diagnostic: () => undefined,
  })
  services.push(service)
  return { service, store, provider, workspace }
}

async function expectError(promise: Promise<unknown> | (() => unknown), status: number, code: string): Promise<void> {
  try {
    await (typeof promise === 'function' ? promise() : promise)
  } catch (error) {
    expect(error).toBeInstanceOf(AgentPlaneError)
    expect((error as AgentPlaneError).statusCode).toBe(status)
    expect((error as AgentPlaneError).code).toBe(code)
    return
  }
  throw new Error(`esperava ${code}`)
}

describe('SessionService — criação', () => {
  it('valida o corpo sem aceitar campos extras nem valores perigosos', async () => {
    const { service } = harness()
    await expectError(service.create(OWNER, { provider: 'claude', workspace: 'backend', cwd: '/etc' }), 400, 'invalid_request')
    await expectError(service.create(OWNER, { provider: 'openai', workspace: 'backend' }), 400, 'invalid_provider')
    await expectError(service.create(OWNER, { provider: 'claude', workspace: '../etc' }), 400, 'invalid_request')
    await expectError(service.create(OWNER, { provider: 'claude', workspace: 'backend', model: '--dangerously-skip-permissions' }), 400, 'invalid_request')
    await expectError(service.create(OWNER, { provider: 'claude', workspace: 'backend', effort: 'max' }), 400, 'invalid_effort')
    await expectError(service.create(OWNER, { provider: 'claude', workspace: 'backend', permissionMode: 'bypassPermissions' }), 400, 'invalid_request')
    await expectError(service.create(OWNER, { provider: 'claude', workspace: 'outro' }), 404, 'workspace_not_found')
    await expectError(service.create(OWNER, 'texto'), 400, 'invalid_request')
    await expectError(service.create(OWNER, { provider: 'claude', workspace: 'backend', worker: 'devbox' }), 503, 'worker_unavailable')
    await expectError(service.create(OWNER, { provider: 'agy', workspace: 'backend', worker: 'devbox' }), 400, 'worker_not_supported_for_provider')
  })

  it('recusa provider desabilitado ou não instalado, sem fallback', async () => {
    const disabled = harness({ enabled: ['agy'] })
    await expectError(disabled.service.create(OWNER, { provider: 'claude', workspace: 'backend' }), 503, 'provider_unavailable')
    const provider = new ScriptedProvider('claude')
    provider.health = async () => ({ installed: false, authenticated: null, version: null })
    await expectError(harness({ provider }).service.create(OWNER, { provider: 'claude-agent', workspace: 'backend' }), 503, 'provider_unavailable')
  })

  it('cria a sessão pronta, com versões e sem conteúdo persistido', async () => {
    const { service, store, provider, workspace } = harness()
    const view = await service.create(OWNER, { provider: 'claude-agent', workspace: 'backend', model: 'sonnet', effort: 'high' })
    expect(view).toMatchObject({
      provider: 'claude',
      status: 'ready',
      nativeSessionId: 'native-1',
      workspace: 'backend',
      worker: null,
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'review',
      providerVersion: '9.9.9',
      adapterVersion: '1',
      protocolVersion: 'scripted-v1',
      currentTurn: null,
      pendingApprovals: [],
    })
    expect(view.id).toMatch(/^agt_[a-f0-9]{24}$/u)
    expect(provider.last.options.workspace).toEqual({ kind: 'local', id: 'backend', root: workspace })
    const record = store.get(view.id) as SessionRecord
    expect(Object.keys(record).sort()).toEqual(
      [
        'adapterVersion',
        'closedAt',
        'createdAt',
        'effort',
        'id',
        'model',
        'nativeSessionId',
        'ownerCredentialId',
        'permissionMode',
        'protocolVersion',
        'provider',
        'providerVersion',
        'status',
        'updatedAt',
        'workerId',
        'workspaceId',
      ].sort(),
    )
  })

  it('marca como failed e responde 502 quando o agente não inicia', async () => {
    const provider = new ScriptedProvider('claude')
    provider.failCreate = true
    const { service, store } = harness({ provider })
    await expectError(service.create(OWNER, { provider: 'claude', workspace: 'backend' }), 502, 'agent_start_failed')
    expect(store.recoverAfterRestart('agora')).toEqual({ suspended: 0, failed: 0 })
  })

  it('aplica limite global e por provider', async () => {
    const perProvider = harness({ limits: { maxSessionsPerProvider: 1 } })
    await perProvider.service.create(OWNER, { provider: 'claude', workspace: 'backend' })
    await expectError(perProvider.service.create(OWNER, { provider: 'claude', workspace: 'backend' }), 429, 'agent_session_limit')
    await perProvider.service.create(OWNER, { provider: 'agy', workspace: 'backend' })

    const global = harness({ limits: { maxSessions: 1, maxSessionsPerProvider: 1 } })
    await global.service.create(OWNER, { provider: 'claude', workspace: 'backend' })
    await expectError(global.service.create(OWNER, { provider: 'agy', workspace: 'backend' }), 429, 'agent_session_limit')
  })
})

describe('SessionService — turnos e eventos', () => {
  it('executa um turno, numera eventos e volta a ready', async () => {
    const { service, provider } = harness()
    const { id } = await service.create(OWNER, { provider: 'claude', workspace: 'backend' })
    const accepted = await service.startTurn(OWNER, id, { input: 'olá' })
    expect(accepted).toMatchObject({ sessionId: id, status: 'running' })
    expect(service.get(OWNER, id)).toMatchObject({ status: 'running', currentTurn: { id: accepted.turnId, status: 'running' } })
    await expectError(service.startTurn(OWNER, id, { input: 'outro' }), 409, 'turn_in_progress')

    provider.last.push({ event: 'session.started', nativeSessionId: 'native-2', native: { type: 'system' } })
    provider.last.push({ event: 'message.delta', text: 'oi', native: { raw: 1 } })
    provider.last.push({ event: 'turn.completed', output: 'oi', native: { raw: 2 } })
    await flush()

    const events = service.events(OWNER, id).since(0)
    expect(events.map((event) => [event.id, event.event])).toEqual([
      [1, 'turn.started'],
      [2, 'session.started'],
      [3, 'message.delta'],
      [4, 'turn.completed'],
    ])
    expect(events.every((event) => event.sessionId === id && event.turnId === accepted.turnId && event.provider === 'claude')).toBe(true)
    expect(provider.last.inputs).toEqual([{ turnId: accepted.turnId, text: 'olá' }])
    expect(service.get(OWNER, id)).toMatchObject({ status: 'ready', currentTurn: null, nativeSessionId: 'native-2' })
  })

  it('valida a entrada do turno', async () => {
    const { service } = harness({ limits: { maxInputChars: 5 } })
    const { id } = await service.create(OWNER, { provider: 'claude', workspace: 'backend' })
    await expectError(service.startTurn(OWNER, id, { input: '   ' }), 400, 'invalid_request')
    await expectError(service.startTurn(OWNER, id, { input: 'longo demais' }), 400, 'invalid_request')
    await expectError(service.startTurn(OWNER, id, { input: 'ok', extra: 1 }), 400, 'invalid_request')
  })

  it('isola sessões por credencial com 404', async () => {
    const { service } = harness()
    const { id } = await service.create(OWNER, { provider: 'claude', workspace: 'backend' })
    await expectError(() => service.get(OTHER, id), 404, 'session_not_found')
    await expectError(() => service.events(OTHER, id), 404, 'session_not_found')
    await expectError(service.startTurn(OTHER, id, { input: 'x' }), 404, 'session_not_found')
    await expectError(() => service.cancel(OTHER, id), 404, 'session_not_found')
    await expectError(service.close(OTHER, id), 404, 'session_not_found')
    await expectError(() => service.get(OWNER, 'agt_inexistente'), 404, 'session_not_found')
  })

  it('cancela o turno e trata cancelamento sem turno', async () => {
    const { service, provider } = harness()
    const { id } = await service.create(OWNER, { provider: 'claude', workspace: 'backend' })
    await expectError(() => service.cancel(OWNER, id), 409, 'no_turn_in_progress')
    const { turnId } = await service.startTurn(OWNER, id, { input: 'trabalhe' })
    expect(service.cancel(OWNER, id)).toEqual({ sessionId: id, turnId, status: 'cancelling' })
    expect(service.cancel(OWNER, id).status).toBe('cancelling')
    await flush()
    expect(provider.last.cancelCalls).toBe(1)
    expect(service.events(OWNER, id).since(0).at(-1)).toMatchObject({ event: 'turn.failed', error: { code: 'turn_cancelled' } })
    expect(service.get(OWNER, id).status).toBe('ready')
  })

  it('reescreve a falha como turn_timeout quando o tempo do turno esgota', async () => {
    const { service, provider } = harness({ limits: { turnTimeoutMs: 20 } })
    const { id } = await service.create(OWNER, { provider: 'claude', workspace: 'backend' })
    await service.startTurn(OWNER, id, { input: 'demorado' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    await flush()
    expect(provider.last.cancelCalls).toBe(1)
    expect(service.events(OWNER, id).since(0).at(-1)).toMatchObject({ event: 'turn.failed', error: { code: 'turn_timeout' } })
  })

  it('derruba o processo quando o agente ignora a interrupção', async () => {
    const { service, provider } = harness({ limits: { cancelGraceMs: 20 } })
    const { id } = await service.create(OWNER, { provider: 'claude', workspace: 'backend' })
    await service.startTurn(OWNER, id, { input: 'teimoso' })
    const runtime = provider.last
    runtime.ignoreCancel = true
    service.cancel(OWNER, id)
    await new Promise((resolve) => setTimeout(resolve, 60))
    await flush()
    expect(runtime.closed).toBe(true)
    expect(service.events(OWNER, id).since(0).at(-1)).toMatchObject({ event: 'turn.failed', error: { code: 'turn_cancelled' } })
    expect(service.get(OWNER, id).status).toBe('suspended')
  })

  it('suspende por ociosidade e retoma pela sessão nativa no próximo turno', async () => {
    const { service, provider } = harness({ limits: { idleTimeoutMs: 20 } })
    const { id } = await service.create(OWNER, { provider: 'claude', workspace: 'backend' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(provider.last.closed).toBe(true)
    expect(service.get(OWNER, id).status).toBe('suspended')

    await service.startTurn(OWNER, id, { input: 'voltei' })
    expect(provider.resumeCalls).toEqual(['native-1'])
    expect(service.get(OWNER, id).status).toBe('running')
  })

  it('marca failed quando a retomada perderia o contexto', async () => {
    const provider = new ScriptedProvider('claude')
    const { service } = harness({ provider })
    const { id } = await service.create(OWNER, { provider: 'claude', workspace: 'backend' })
    provider.last.exit()
    expect(service.get(OWNER, id).status).toBe('suspended')
    provider.resumeError = new AgentResumeError('perdida')
    await expectError(service.startTurn(OWNER, id, { input: 'x' }), 502, 'agent_start_failed')
    expect(service.get(OWNER, id).status).toBe('failed')
    await expectError(service.startTurn(OWNER, id, { input: 'x' }), 409, 'session_failed')
  })

  it('mantém suspended quando a retomada falha por outro motivo e failed sem sessão nativa', async () => {
    const provider = new ScriptedProvider('claude')
    const { service } = harness({ provider })
    const { id } = await service.create(OWNER, { provider: 'claude', workspace: 'backend' })
    provider.last.exit()
    provider.resumeError = new Error('binário sumiu')
    await expectError(service.startTurn(OWNER, id, { input: 'x' }), 502, 'agent_start_failed')
    expect(service.get(OWNER, id).status).toBe('suspended')

    const noNative = new ScriptedProvider('claude')
    noNative.nativeId = undefined
    const second = harness({ provider: noNative })
    const created = await second.service.create(OWNER, { provider: 'claude', workspace: 'backend' })
    noNative.last.exit()
    expect(second.service.get(OWNER, created.id).status).toBe('failed')
  })

  it('encerra a sessão, nega aprovações e fecha o stream de eventos', async () => {
    const { service, provider } = harness()
    const { id } = await service.create(OWNER, { provider: 'claude', workspace: 'backend' })
    await service.startTurn(OWNER, id, { input: 'x' })
    const decision = provider.last.context.requestApproval({ tool: 'Bash', summary: 'ls', native: {} })
    const closed = await service.close(OWNER, id)
    expect(closed.status).toBe('closed')
    await expect(decision).resolves.toBe('deny')
    expect(provider.last.closed).toBe(true)
    const log = service.events(OWNER, id)
    expect(log.isClosed).toBe(true)
    expect(log.since(0).map((event) => event.event)).toEqual([
      'turn.started',
      'approval.required',
      'approval.resolved',
      'turn.failed',
      'session.closed',
    ])
    await expectError(service.startTurn(OWNER, id, { input: 'x' }), 409, 'session_closed')
    expect((await service.close(OWNER, id)).status).toBe('closed')
  })
})

describe('SessionService — aprovações', () => {
  it('cria, decide e isola aprovações', async () => {
    const { service, provider } = harness()
    const { id } = await service.create(OWNER, { provider: 'claude', workspace: 'backend' })
    await service.startTurn(OWNER, id, { input: 'x' })
    const decision = provider.last.context.requestApproval({ tool: 'Bash', summary: 'npm install x', native: { raw: true } })
    const pending = service.get(OWNER, id).pendingApprovals
    expect(pending).toHaveLength(1)
    const approval = pending[0]
    if (!approval) throw new Error('aprovação ausente')
    expect(approval).toMatchObject({ sessionId: id, tool: 'Bash', summary: 'npm install x', status: 'pending', provider: 'claude' })

    await expectError(() => service.decideApproval(OTHER, approval.id, { decision: 'allow' }), 404, 'approval_not_found')
    await expectError(() => service.decideApproval(OWNER, approval.id, { decision: 'talvez' }), 400, 'invalid_decision')
    await expectError(() => service.decideApproval(OWNER, approval.id, { decision: 'allow', extra: 1 }), 400, 'invalid_decision')
    expect(service.decideApproval(OWNER, approval.id, { decision: 'allow' })).toMatchObject({ status: 'allowed' })
    await expect(decision).resolves.toBe('allow')
    await expectError(() => service.decideApproval(OWNER, approval.id, { decision: 'deny' }), 409, 'approval_already_resolved')
    await expectError(() => service.decideApproval(OWNER, 'apr_inexistente', { decision: 'deny' }), 404, 'approval_not_found')

    const events = service.events(OWNER, id).since(0)
    expect(events.find((event) => event.event === 'approval.required')).toMatchObject({ approvalId: approval.id, native: { raw: true } })
    expect(events.find((event) => event.event === 'approval.resolved')).toMatchObject({ decision: 'allow', reason: 'client' })
  })

  it('nega por expiração e por cancelamento do próprio agente', async () => {
    const { service, provider } = harness({ limits: { approvalTimeoutMs: 20 } })
    const { id } = await service.create(OWNER, { provider: 'claude', workspace: 'backend' })
    await service.startTurn(OWNER, id, { input: 'x' })
    await expect(provider.last.context.requestApproval({ tool: 'Bash', summary: 'ls', native: {} })).resolves.toBe('deny')
    const controller = new AbortController()
    const aborted = provider.last.context.requestApproval({ tool: 'Bash', summary: 'ls', native: {}, signal: controller.signal })
    controller.abort()
    await expect(aborted).resolves.toBe('deny')
    const reasons = service
      .events(OWNER, id)
      .since(0)
      .filter((event) => event.event === 'approval.resolved')
      .map((event) => event.reason)
    expect(reasons).toEqual(['timeout', 'cancelled'])
  })
})

describe('SessionStore', () => {
  it('recupera sessões ativas após reinício em memória', async () => {
    const { service, store } = harness()
    const { id } = await service.create(OWNER, { provider: 'claude', workspace: 'backend' })
    expect(store.recoverAfterRestart('depois')).toEqual({ suspended: 1, failed: 0 })
    expect(store.get(id)?.status).toBe('suspended')
    expect(() => store.insert(store.get(id) as SessionRecord)).toThrow()
    expect(store.update('agt_x', { status: 'failed' }, 'agora')).toBeUndefined()
  })

  it('libera da memória sessões históricas lidas do banco', async () => {
    const { service, store } = harness({ limits: { closedRetentionMs: 20 } })
    const { id } = await service.create(OWNER, { provider: 'claude', workspace: 'backend' })
    await service.close(OWNER, id)
    await new Promise((resolve) => setTimeout(resolve, 50))
    store.update(id, { model: 'alterado-no-banco' }, 'agora')
    expect(service.get(OWNER, id).model).toBe('alterado-no-banco')
    store.update(id, { model: 'de-novo' }, 'agora')
    expect(service.get(OWNER, id).model).toBe('alterado-no-banco')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(service.get(OWNER, id).model).toBe('de-novo')
    expect(service.events(OWNER, id).isClosed).toBe(true)
  })

  it('persiste somente metadados em SQLite 0600 e recupera após reinício', async () => {
    const directory = tempDir()
    const path = join(directory, 'dados', 'agentd.db')
    const store = await SqliteSessionStore.open(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const record: SessionRecord = {
      id: 'agt_000000000000000000000001',
      provider: 'codex',
      nativeSessionId: null,
      workerId: null,
      workspaceId: 'backend',
      status: 'ready',
      model: null,
      effort: 'low',
      permissionMode: 'plan',
      ownerCredentialId: 'abc',
      providerVersion: '0.144.6',
      adapterVersion: '1',
      protocolVersion: 'codex-app-server-v2',
      createdAt: '2026-09-25T00:00:00.000Z',
      updatedAt: '2026-09-25T00:00:00.000Z',
      closedAt: null,
    }
    store.insert(record)
    store.insert({ ...record, id: 'agt_000000000000000000000002', nativeSessionId: 'thread-1', status: 'running' })
    expect(store.update(record.id, { model: 'gpt-x' }, '2026-09-25T00:00:01.000Z')).toMatchObject({ model: 'gpt-x', updatedAt: '2026-09-25T00:00:01.000Z' })
    expect(store.healthy()).toBe(true)
    store.close()

    const reopened = await SqliteSessionStore.open(path)
    expect(reopened.recoverAfterRestart('2026-09-25T00:00:02.000Z')).toEqual({ suspended: 1, failed: 1 })
    expect(reopened.get(record.id)?.status).toBe('failed')
    expect(reopened.get('agt_000000000000000000000002')).toMatchObject({ status: 'suspended', nativeSessionId: 'thread-1' })
    expect(reopened.get('agt_inexistente')).toBeUndefined()
    reopened.close()
    expect(reopened.healthy()).toBe(false)
  })
})
