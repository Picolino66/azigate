import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord, type AgentEventDraft } from '../agents/core/agent-event.js'
import {
  isPermissionMode,
  normalizeProviderId,
  type AgentProvider,
  type AgentProviderId,
  type AgentRuntimeSession,
  type AgentSessionContext,
  type AgentSessionOptions,
  type PermissionMode,
  type WorkspaceTarget,
} from '../agents/core/agent-provider.js'
import type { AgentRegistry } from '../agents/core/agent-registry.js'
import { newId } from '../agents/core/ids.js'
import { AgentResumeError } from '../agents/core/process-session.js'
import { ApprovalService, type ApprovalView } from './approvals.js'
import { AgentPlaneError, notFound } from './errors.js'
import { SessionEventLog } from './events.js'
import { MCP_SERVER_NAME, READ_ONLY_MCP_TOOLS, type RemoteToolGateway } from './remote-tools.js'
import type { SessionRecord, SessionStatus, SessionStore } from './session-store.js'
import type { WorkerHub } from './workers.js'
import { WORKSPACE_ID_PATTERN } from './workspaces.js'

export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u
const CREATE_FIELDS = new Set(['provider', 'workspace', 'worker', 'model', 'effort', 'permissionMode'])
const ACTIVE_STATUSES: ReadonlySet<SessionStatus> = new Set(['starting', 'ready', 'running'])

export interface SessionLimits {
  maxSessions: number
  maxSessionsPerProvider: number
  idleTimeoutMs: number
  turnTimeoutMs: number
  approvalTimeoutMs: number
  cancelGraceMs: number
  eventBufferSize: number
  eventBufferBytes: number
  maxInputChars: number
  closedRetentionMs: number
}

export interface McpBridgeLaunch {
  command: string
  args: readonly string[]
  socketPath: string
}

export type Diagnostic = (event: string, fields?: Record<string, string | number | boolean>) => void

export interface SessionServiceDeps {
  store: SessionStore
  registry: AgentRegistry
  localWorkspaces: ReadonlyMap<string, string>
  workers?: WorkerHub
  remoteTools?: RemoteToolGateway
  mcpBridge?: McpBridgeLaunch
  dataDir: string
  limits: SessionLimits
  diagnostic: Diagnostic
  now?: () => Date
}

export interface SessionView {
  id: string
  provider: AgentProviderId
  status: SessionStatus
  nativeSessionId: string | null
  workspace: string
  worker: string | null
  model: string | null
  effort: string | null
  permissionMode: PermissionMode
  providerVersion: string | null
  adapterVersion: string
  protocolVersion: string
  createdAt: string
  updatedAt: string
  currentTurn: { id: string; status: 'running' | 'cancelling'; startedAt: string } | null
  pendingApprovals: ApprovalView[]
}

interface LiveTurn {
  id: string
  startedAt: string
  status: 'running' | 'cancelling'
  timedOut: boolean
  timer: NodeJS.Timeout | undefined
  forceTimer: NodeJS.Timeout | undefined
}

interface LiveSession {
  record: SessionRecord
  log: SessionEventLog
  runtime: AgentRuntimeSession | undefined
  turn: LiveTurn | undefined
  idleTimer: NodeJS.Timeout | undefined
  busy: boolean
}

interface CreateRequest {
  provider: AgentProviderId
  workspace: string
  worker?: string
  model?: string
  effort?: string
  permissionMode: PermissionMode
}

type ResolvedWorkspace = { kind: 'local'; root: string } | { kind: 'remote'; workerId: string }

function invalid(message: string, code = 'invalid_request'): AgentPlaneError {
  return new AgentPlaneError(400, code, message)
}

function validateCreate(body: unknown): CreateRequest {
  if (!isRecord(body)) throw invalid('O corpo precisa ser um objeto JSON')
  for (const key of Object.keys(body)) {
    if (!CREATE_FIELDS.has(key)) throw invalid(`Campo não permitido: ${key.slice(0, 64)}`)
  }
  const provider = normalizeProviderId(body.provider)
  if (!provider) throw invalid('provider deve ser codex, claude ou agy', 'invalid_provider')
  if (typeof body.workspace !== 'string' || !WORKSPACE_ID_PATTERN.test(body.workspace)) {
    throw invalid('workspace deve ser um identificador válido')
  }
  const request: CreateRequest = { provider, workspace: body.workspace, permissionMode: 'review' }
  if (body.worker !== undefined) {
    if (typeof body.worker !== 'string' || !WORKSPACE_ID_PATTERN.test(body.worker)) {
      throw invalid('worker deve ser um identificador válido')
    }
    request.worker = body.worker
  }
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || !MODEL_PATTERN.test(body.model)) throw invalid('model inválido')
    request.model = body.model
  }
  if (body.effort !== undefined) {
    if (typeof body.effort !== 'string') throw invalid('effort inválido', 'invalid_effort')
    request.effort = body.effort
  }
  if (body.permissionMode !== undefined) {
    if (!isPermissionMode(body.permissionMode)) throw invalid('permissionMode deve ser review, acceptEdits ou plan')
    request.permissionMode = body.permissionMode
  }
  return request
}

/**
 * Ciclo de vida das sessões do Agent Plane: criação, turnos, cancelamento, ociosidade,
 * retomada pela sessão nativa, aprovações e eventos (ADR-022/ADR-024).
 */
export class SessionService {
  private readonly sessions = new Map<string, LiveSession>()
  readonly approvals: ApprovalService
  private readonly now: () => Date

  constructor(private readonly deps: SessionServiceDeps) {
    this.now = deps.now ?? (() => new Date())
    this.approvals = new ApprovalService((resolution) => {
      const live = this.sessions.get(resolution.view.sessionId)
      if (!live) return
      this.append(live, {
        event: 'approval.resolved',
        approvalId: resolution.view.id,
        tool: resolution.view.tool,
        decision: resolution.decision,
        reason: resolution.reason,
      }, resolution.view.turnId ?? undefined)
    }, this.now)
  }

  recoverOnStartup(): { suspended: number; failed: number } {
    return this.deps.store.recoverAfterRestart(this.timestamp())
  }

  async create(owner: string, body: unknown): Promise<SessionView> {
    const request = validateCreate(body)
    const provider = await this.availableProvider(request.provider)
    if (request.effort !== undefined && !provider.efforts.includes(request.effort)) {
      throw invalid(`effort não suportado por ${provider.id}: use ${provider.efforts.join(', ')}`, 'invalid_effort')
    }
    const workspace = this.resolveWorkspace(provider, request)
    this.ensureCapacity(provider.id)
    const status = await this.deps.registry.status(provider.id)
    const now = this.timestamp()
    const record: SessionRecord = {
      id: newId('agt'),
      provider: provider.id,
      nativeSessionId: null,
      workerId: workspace.kind === 'remote' ? workspace.workerId : null,
      workspaceId: request.workspace,
      status: 'starting',
      model: request.model ?? null,
      effort: request.effort ?? null,
      permissionMode: request.permissionMode,
      ownerCredentialId: owner,
      providerVersion: status?.version ?? null,
      adapterVersion: provider.adapterVersion,
      protocolVersion: provider.protocolVersion,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    }
    this.deps.store.insert(record)
    const live: LiveSession = {
      record,
      log: new SessionEventLog(this.deps.limits.eventBufferSize, this.deps.limits.eventBufferBytes),
      runtime: undefined,
      turn: undefined,
      idleTimer: undefined,
      busy: true,
    }
    this.sessions.set(record.id, live)
    try {
      await this.startRuntime(live, provider, 'new')
    } catch {
      this.patch(live, { status: 'failed' })
      this.deps.remoteTools?.revokeSession(record.id)
      this.deps.diagnostic('agent_session_start_failed', { sessionId: record.id, provider: provider.id })
      throw new AgentPlaneError(502, 'agent_start_failed', 'Não foi possível iniciar o agente')
    } finally {
      live.busy = false
    }
    this.deps.diagnostic('agent_session_created', { sessionId: record.id, provider: provider.id })
    return this.view(live)
  }

  get(owner: string, id: string): SessionView {
    return this.view(this.owned(owner, id))
  }

  events(owner: string, id: string): SessionEventLog {
    return this.owned(owner, id).log
  }

  async startTurn(owner: string, id: string, body: unknown): Promise<{ sessionId: string; turnId: string; status: 'running' }> {
    const live = this.owned(owner, id)
    if (!isRecord(body) || typeof body.input !== 'string' || Object.keys(body).some((key) => key !== 'input')) {
      throw invalid('O corpo deve ser { "input": "texto" }')
    }
    const text = body.input
    if (text.trim().length === 0 || text.length > this.deps.limits.maxInputChars) {
      throw invalid(`input deve ter entre 1 e ${this.deps.limits.maxInputChars} caracteres`)
    }
    this.assertTurnAllowed(live)
    if (!live.runtime) await this.resume(live)
    const runtime = live.runtime
    if (!runtime) throw new AgentPlaneError(502, 'agent_start_failed', 'Não foi possível iniciar o agente')
    this.assertTurnAllowed(live)

    const turnId = newId('trn')
    const turn: LiveTurn = {
      id: turnId,
      startedAt: this.timestamp(),
      status: 'running',
      timedOut: false,
      timer: undefined,
      forceTimer: undefined,
    }
    live.turn = turn
    this.clearIdle(live)
    this.patch(live, { status: 'running' })
    this.append(live, { event: 'turn.started' }, turnId)
    turn.timer = setTimeout(() => this.timeoutTurn(live, turnId), this.deps.limits.turnTimeoutMs)
    turn.timer.unref()
    void this.consumeTurn(live, runtime, turnId, text)
    return { sessionId: id, turnId, status: 'running' }
  }

  cancel(owner: string, id: string): { sessionId: string; turnId: string; status: 'cancelling' } {
    const live = this.owned(owner, id)
    const turn = live.turn
    if (!turn) throw new AgentPlaneError(409, 'no_turn_in_progress', 'Não há turno em andamento')
    if (turn.status !== 'cancelling') {
      turn.status = 'cancelling'
      this.approvals.cancelForSession(id, 'cancelled')
      const runtime = live.runtime
      void runtime?.cancelTurn().catch(() => undefined)
      this.scheduleForcedFinish(live, turn, 'turn_cancelled', 'Turno cancelado')
    }
    return { sessionId: id, turnId: turn.id, status: 'cancelling' }
  }

  async close(owner: string, id: string): Promise<SessionView> {
    const live = this.owned(owner, id)
    if (live.record.status === 'closed') return this.view(live)
    this.patch(live, { status: 'closed', closedAt: this.timestamp() })
    this.approvals.cancelForSession(id, 'session_closed')
    this.deps.remoteTools?.revokeSession(id)
    this.clearIdle(live)
    const runtime = live.runtime
    live.runtime = undefined
    if (live.turn) {
      this.append(live, { event: 'turn.failed', error: { code: 'turn_cancelled', message: 'Sessão encerrada' } }, live.turn.id)
      this.clearTurn(live)
    }
    await runtime?.close().catch(() => undefined)
    this.append(live, { event: 'session.closed' })
    live.log.close()
    rmSync(this.sessionDir(id), { recursive: true, force: true })
    setTimeout(() => this.sessions.delete(id), this.deps.limits.closedRetentionMs).unref()
    this.deps.diagnostic('agent_session_closed', { sessionId: id, provider: live.record.provider })
    return this.view(live)
  }

  decideApproval(owner: string, approvalId: string, body: unknown): ApprovalView {
    if (!isRecord(body) || Object.keys(body).some((key) => key !== 'decision')) {
      throw invalid('O corpo deve ser { "decision": "allow" | "deny" }', 'invalid_decision')
    }
    return this.approvals.decide(owner, approvalId, body.decision)
  }

  /** Encerra todos os processos; as sessões ficam `suspended` e podem ser retomadas depois. */
  async shutdown(): Promise<void> {
    this.approvals.cancelAll()
    await Promise.all(
      [...this.sessions.values()].map(async (live) => {
        this.clearIdle(live)
        await live.runtime?.close().catch(() => undefined)
      }),
    )
  }

  private async availableProvider(id: AgentProviderId): Promise<AgentProvider> {
    const provider = this.deps.registry.get(id)
    const status = provider ? await this.deps.registry.status(id) : undefined
    if (!provider || !status?.available) {
      throw new AgentPlaneError(503, 'provider_unavailable', 'Provider de agente indisponível')
    }
    return provider
  }

  private resolveWorkspace(provider: AgentProvider, request: CreateRequest): ResolvedWorkspace {
    if (request.worker === undefined) {
      const root = this.deps.localWorkspaces.get(request.workspace)
      if (!root) throw new AgentPlaneError(404, 'workspace_not_found', 'Workspace não encontrado')
      return { kind: 'local', root }
    }
    if (!provider.supportsRemoteWorkspace) {
      throw invalid('Este provider ainda não suporta workspace remoto', 'worker_not_supported_for_provider')
    }
    this.assertWorkerAvailable(request.worker, request.workspace)
    return { kind: 'remote', workerId: request.worker }
  }

  private assertWorkerAvailable(workerId: string, workspace: string): void {
    const hub = this.deps.workers
    if (!hub || !this.deps.remoteTools || !this.deps.mcpBridge || !hub.isConnected(workerId)) {
      throw new AgentPlaneError(503, 'worker_unavailable', 'Worker indisponível')
    }
    if (!hub.hasWorkspace(workerId, workspace)) {
      throw new AgentPlaneError(404, 'workspace_not_found', 'Workspace não encontrado')
    }
  }

  private ensureCapacity(provider: AgentProviderId): void {
    let total = 0
    let perProvider = 0
    for (const live of this.sessions.values()) {
      if (!ACTIVE_STATUSES.has(live.record.status)) continue
      total += 1
      if (live.record.provider === provider) perProvider += 1
    }
    if (total >= this.deps.limits.maxSessions || perProvider >= this.deps.limits.maxSessionsPerProvider) {
      throw new AgentPlaneError(429, 'agent_session_limit', 'Limite de sessões ativas atingido')
    }
  }

  private assertTurnAllowed(live: LiveSession): void {
    if (live.record.status === 'closed') throw new AgentPlaneError(409, 'session_closed', 'A sessão foi encerrada')
    if (live.record.status === 'failed') throw new AgentPlaneError(409, 'session_failed', 'A sessão não pode ser retomada')
    if (live.turn || live.busy) throw new AgentPlaneError(409, 'turn_in_progress', 'Já existe um turno em andamento')
  }

  private async resume(live: LiveSession): Promise<void> {
    const record = live.record
    if (!record.nativeSessionId) {
      this.patch(live, { status: 'failed' })
      throw new AgentPlaneError(409, 'session_failed', 'A sessão não pode ser retomada')
    }
    const provider = await this.availableProvider(record.provider)
    if (record.workerId) this.assertWorkerAvailable(record.workerId, record.workspaceId)
    else if (!this.deps.localWorkspaces.has(record.workspaceId)) {
      throw new AgentPlaneError(404, 'workspace_not_found', 'Workspace não encontrado')
    }
    this.assertTurnAllowed(live)
    this.ensureCapacity(record.provider)
    live.busy = true
    this.patch(live, { status: 'starting' })
    try {
      await this.startRuntime(live, provider, 'resume')
    } catch (error) {
      const resumeLost = error instanceof AgentResumeError
      if (live.record.status !== 'closed') this.patch(live, { status: resumeLost ? 'failed' : 'suspended' })
      this.deps.diagnostic('agent_session_resume_failed', {
        sessionId: record.id,
        provider: record.provider,
        contextLost: resumeLost,
      })
      throw new AgentPlaneError(502, 'agent_start_failed', 'Não foi possível retomar a sessão do agente')
    } finally {
      live.busy = false
    }
  }

  private async startRuntime(live: LiveSession, provider: AgentProvider, mode: 'new' | 'resume'): Promise<void> {
    const record = live.record
    const sessionDir = this.sessionDir(record.id)
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
    chmodSync(sessionDir, 0o700)
    const workspace = this.workspaceTarget(record, sessionDir)
    const options: AgentSessionOptions = {
      sessionId: record.id,
      workspace,
      sessionDir,
      permissionMode: record.permissionMode,
      ...(record.model ? { model: record.model } : {}),
      ...(record.effort ? { effort: record.effort } : {}),
    }
    const context = this.contextFor(live)
    let runtime: AgentRuntimeSession
    try {
      runtime =
        mode === 'new' || !record.nativeSessionId
          ? await provider.createSession(options, context)
          : await provider.resumeSession(record.nativeSessionId, options, context)
    } catch (error) {
      this.deps.remoteTools?.revokeSession(record.id)
      throw error
    }
    if (live.record.status === 'closed') {
      await runtime.close().catch(() => undefined)
      throw new AgentPlaneError(409, 'session_closed', 'A sessão foi encerrada')
    }
    live.runtime = runtime
    runtime.onExit(() => this.handleExit(live, runtime))
    this.patch(live, {
      status: 'ready',
      nativeSessionId: runtime.nativeSessionId ?? live.record.nativeSessionId,
    })
    this.scheduleIdle(live)
  }

  private workspaceTarget(record: SessionRecord, sessionDir: string): WorkspaceTarget {
    if (!record.workerId) {
      const root = this.deps.localWorkspaces.get(record.workspaceId)
      if (!root) throw new AgentPlaneError(404, 'workspace_not_found', 'Workspace não encontrado')
      return { kind: 'local', id: record.workspaceId, root }
    }
    const bridge = this.deps.mcpBridge
    const remoteTools = this.deps.remoteTools
    if (!bridge || !remoteTools) throw new AgentPlaneError(503, 'worker_unavailable', 'Worker indisponível')
    remoteTools.revokeSession(record.id)
    const token = remoteTools.issue({
      sessionId: record.id,
      workerId: record.workerId,
      workspaceId: record.workspaceId,
      permissionMode: record.permissionMode,
    })
    const mcpConfigPath = join(sessionDir, 'mcp-config.json')
    const config = {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'stdio',
          command: bridge.command,
          args: [...bridge.args],
          env: { AZIGATE_MCP_SOCKET: bridge.socketPath, AZIGATE_MCP_TOKEN: token },
        },
      },
    }
    writeFileSync(mcpConfigPath, JSON.stringify(config), { mode: 0o600 })
    chmodSync(mcpConfigPath, 0o600)
    return {
      kind: 'remote',
      id: record.workspaceId,
      workerId: record.workerId,
      mcpConfigPath,
      allowedTools: READ_ONLY_MCP_TOOLS,
    }
  }

  private contextFor(live: LiveSession): AgentSessionContext {
    const record = live.record
    return {
      requestApproval: (request) => {
        const { view, decision } = this.approvals.create({
          sessionId: record.id,
          turnId: live.turn?.id ?? null,
          provider: record.provider,
          tool: request.tool,
          summary: request.summary,
          owner: record.ownerCredentialId,
          timeoutMs: this.deps.limits.approvalTimeoutMs,
          ...(request.signal ? { signal: request.signal } : {}),
        })
        if (view.status === 'pending') {
          this.append(
            live,
            { event: 'approval.required', approvalId: view.id, tool: view.tool, summary: view.summary, native: request.native },
            view.turnId ?? undefined,
          )
        }
        return decision
      },
      emit: (event) => this.append(live, event, live.turn?.id),
      diagnostic: (event, fields) =>
        this.deps.diagnostic(event, { sessionId: record.id, provider: record.provider, ...fields }),
    }
  }

  private async consumeTurn(live: LiveSession, runtime: AgentRuntimeSession, turnId: string, text: string): Promise<void> {
    let terminal = false
    try {
      for await (const draft of runtime.startTurn({ turnId, text })) {
        const turn = live.turn
        if (turn?.id !== turnId) break
        let event = draft
        if (draft.event === 'turn.failed' && turn.timedOut) {
          event = { ...draft, error: { code: 'turn_timeout', message: 'Tempo máximo do turno excedido' } }
        }
        this.append(live, event, turnId)
        if (draft.event === 'turn.completed' || draft.event === 'turn.failed') {
          terminal = true
          break
        }
      }
    } catch {
      this.deps.diagnostic('agent_turn_iteration_error', { sessionId: live.record.id })
    }
    if (live.turn?.id !== turnId) return
    if (!terminal) {
      this.append(
        live,
        { event: 'turn.failed', error: { code: 'agent_protocol_error', message: 'O agente encerrou o turno sem resultado' } },
        turnId,
      )
    }
    this.finishTurn(live)
  }

  private finishTurn(live: LiveSession): void {
    this.clearTurn(live)
    this.approvals.cancelForSession(live.record.id, 'cancelled')
    if (live.record.status === 'closed') return
    if (live.runtime) {
      this.patch(live, { status: 'ready' })
      this.scheduleIdle(live)
    }
  }

  private clearTurn(live: LiveSession): void {
    if (live.turn?.timer) clearTimeout(live.turn.timer)
    if (live.turn?.forceTimer) clearTimeout(live.turn.forceTimer)
    live.turn = undefined
  }

  private timeoutTurn(live: LiveSession, turnId: string): void {
    const turn = live.turn
    if (turn?.id !== turnId) return
    turn.timedOut = true
    turn.status = 'cancelling'
    this.approvals.cancelForSession(live.record.id, 'cancelled')
    void live.runtime?.cancelTurn().catch(() => undefined)
    this.scheduleForcedFinish(live, turn, 'turn_timeout', 'Tempo máximo do turno excedido')
    this.deps.diagnostic('agent_turn_timeout', { sessionId: live.record.id, provider: live.record.provider })
  }

  /** Se o agente não encerrar o turno após o pedido de interrupção, derruba o processo. */
  private scheduleForcedFinish(
    live: LiveSession,
    turn: LiveTurn,
    code: 'turn_cancelled' | 'turn_timeout',
    message: string,
  ): void {
    if (turn.forceTimer) return
    turn.forceTimer = setTimeout(() => {
      if (live.turn !== turn) return
      this.append(live, { event: 'turn.failed', error: { code, message } }, turn.id)
      const runtime = live.runtime
      this.finishTurn(live)
      void runtime?.close().catch(() => undefined)
    }, this.deps.limits.cancelGraceMs)
    turn.forceTimer.unref()
  }

  private handleExit(live: LiveSession, runtime: AgentRuntimeSession): void {
    if (live.runtime !== runtime) return
    live.runtime = undefined
    this.clearIdle(live)
    this.deps.remoteTools?.revokeSession(live.record.id)
    this.approvals.cancelForSession(live.record.id, 'cancelled')
    if (live.record.status === 'closed' || live.record.status === 'failed') return
    this.patch(live, { status: live.record.nativeSessionId ? 'suspended' : 'failed' })
  }

  private scheduleIdle(live: LiveSession): void {
    this.clearIdle(live)
    live.idleTimer = setTimeout(() => {
      live.idleTimer = undefined
      if (live.turn || live.busy || !live.runtime) return
      this.deps.diagnostic('agent_session_idle_suspended', { sessionId: live.record.id, provider: live.record.provider })
      void live.runtime.close().catch(() => undefined)
    }, this.deps.limits.idleTimeoutMs)
    live.idleTimer.unref()
  }

  private clearIdle(live: LiveSession): void {
    if (live.idleTimer) clearTimeout(live.idleTimer)
    live.idleTimer = undefined
  }

  private append(live: LiveSession, draft: AgentEventDraft, turnId?: string): void {
    if (live.log.isClosed) return
    live.log.append({
      ...draft,
      sessionId: live.record.id,
      provider: live.record.provider,
      ...(turnId ? { turnId } : {}),
      timestamp: this.timestamp(),
    })
    if (draft.event === 'session.started' && draft.nativeSessionId && draft.nativeSessionId !== live.record.nativeSessionId) {
      this.patch(live, { nativeSessionId: draft.nativeSessionId })
    }
  }

  private patch(live: LiveSession, patch: Parameters<SessionStore['update']>[1]): void {
    const updated = this.deps.store.update(live.record.id, patch, this.timestamp())
    live.record = updated ?? { ...live.record, ...patch }
  }

  private owned(owner: string, id: string): LiveSession {
    let live = this.sessions.get(id)
    if (!live) {
      const record = this.deps.store.get(id)
      if (!record) throw notFound()
      const loaded: LiveSession = {
        record,
        log: new SessionEventLog(this.deps.limits.eventBufferSize, this.deps.limits.eventBufferBytes),
        runtime: undefined,
        turn: undefined,
        idleTimer: undefined,
        busy: false,
      }
      this.sessions.set(id, loaded)
      if (record.status === 'closed' || record.status === 'failed') {
        // Sessões históricas lidas do banco não ficam presas em memória.
        if (record.status === 'closed') loaded.log.close()
        setTimeout(() => {
          if (this.sessions.get(id) === loaded && !loaded.runtime) this.sessions.delete(id)
        }, this.deps.limits.closedRetentionMs).unref()
      }
      live = loaded
    }
    if (live.record.ownerCredentialId !== owner) throw notFound()
    return live
  }

  private view(live: LiveSession): SessionView {
    const record = live.record
    return {
      id: record.id,
      provider: record.provider,
      status: record.status,
      nativeSessionId: record.nativeSessionId,
      workspace: record.workspaceId,
      worker: record.workerId,
      model: record.model,
      effort: record.effort,
      permissionMode: record.permissionMode,
      providerVersion: record.providerVersion,
      adapterVersion: record.adapterVersion,
      protocolVersion: record.protocolVersion,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      currentTurn: live.turn ? { id: live.turn.id, status: live.turn.status, startedAt: live.turn.startedAt } : null,
      pendingApprovals: this.approvals.pendingFor(record.id),
    }
  }

  private sessionDir(id: string): string {
    return join(this.deps.dataDir, 'sessions', id)
  }

  private timestamp(): string {
    return this.now().toISOString()
  }
}
