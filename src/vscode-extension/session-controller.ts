import type { AgentEvent, AgentUsage } from '../agents/core/agent-event.js'
import { AgentApiError, type SessionInfo, type WorkerInfo } from '../agent-client/api.js'
import { formatUsage, toolLabel } from '../agent-client/render.js'
import {
  PROVIDER_IDS,
  PROVIDER_LABELS,
  isProviderId,
  type InboundMessage,
  type OutboundMessage,
  type ProviderId,
  type ServerStatus,
  type ViewState,
} from './protocol.js'

/** Parte da Agent API usada pelo painel (implementada por `AgentApi`). */
export interface AgentApiPort {
  providers(): Promise<Record<string, Record<string, unknown>>>
  workers(): Promise<WorkerInfo[]>
  createSession(body: Record<string, unknown>): Promise<SessionInfo>
  sendTurn(id: string, input: string): Promise<{ turnId: string }>
  decide(approvalId: string, decision: 'allow' | 'deny'): Promise<unknown>
  cancel(id: string): Promise<unknown>
  close(id: string): Promise<unknown>
  events(id: string, after: number, signal: AbortSignal): AsyncIterable<AgentEvent>
}

export interface ControllerHooks {
  /** Envia uma mensagem ao webview. */
  post(message: OutboundMessage): void
  /** Avisa uma aprovação pendente (o host mostra notificação quando o painel está oculto). */
  approvalRequested?(approvalId: string, label: string): void
  /** Inicia ou para o Workspace Server local, quando o host oferece isso. */
  startServer?(): void
  stopServer?(): void
}

export interface ControllerOptions {
  provider?: ProviderId
  /** IDs do `workspace.json` local e o pré-selecionado pela pasta aberta. */
  localWorkspaces?: readonly string[]
  preferredWorkspace?: string | undefined
}

function describe(error: unknown): string {
  if (error instanceof AgentApiError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : 'erro desconhecido'
}

/**
 * Estado e fluxo do painel Azigate: escolhe agente e workspace por ID, cria a sessão no
 * agentd, acompanha o SSE do turno, encaminha aprovações e encerra a sessão (ADR-028).
 * Não depende da API do VS Code; o host só entrega mensagens e mostra notificações.
 */
export class SessionController {
  private api: AgentApiPort | undefined
  private provider: ProviderId
  private providerAvailability = new Map<ProviderId, boolean>()
  private localWorkspaces: string[]
  private remoteWorkers: WorkerInfo[] = []
  private workspace: string | undefined
  private session: SessionInfo | undefined
  private stream: AbortController | undefined
  private lastEventId = 0
  private currentTurn: string | undefined
  private awaitingTurn = false
  private startedMessage = false
  private lastUsage: AgentUsage | undefined
  private readonly pendingApprovals = new Set<string>()
  private server: { status: ServerStatus; detail?: string } = { status: 'stopped' }
  private connection: { ok: boolean; message?: string } = { ok: false, message: 'Conectando ao agentd…' }
  private disposed = false

  constructor(
    private readonly hooks: ControllerHooks,
    options: ControllerOptions = {},
  ) {
    this.provider = options.provider ?? 'claude'
    this.localWorkspaces = [...(options.localWorkspaces ?? [])]
    this.workspace = options.preferredWorkspace ?? this.localWorkspaces[0]
  }

  /** Troca a conexão com o agentd (nova URL ou chave); encerra a sessão da conexão anterior. */
  async setApi(api: AgentApiPort | undefined, failure?: string): Promise<void> {
    await this.endSession()
    this.api = api
    this.connection = api ? { ok: false, message: 'Conectando ao agentd…' } : { ok: false, message: failure ?? 'Sem conexão com o agentd' }
    this.publishState()
    if (api) await this.refresh()
  }

  setLocalWorkspaces(ids: readonly string[], preferred: string | undefined): void {
    this.localWorkspaces = [...ids]
    if (!this.workspace || !this.knownWorkspaces().includes(this.workspace)) this.workspace = preferred ?? ids[0]
    this.publishState()
  }

  setServerStatus(status: ServerStatus, detail?: string): void {
    this.server = detail === undefined ? { status } : { status, detail }
    this.publishState()
    // O agentd vê o worker alguns instantes depois da conexão; a próxima atualização confirma.
    if (status === 'running' || status === 'stopped') void this.refresh()
  }

  get state(): ViewState {
    const workspaceWorker = this.workspace
      ? this.remoteWorkers.find((worker) => worker.workspaces.includes(this.workspace ?? ''))?.id
      : undefined
    return {
      provider: this.provider,
      providers: PROVIDER_IDS.map((id) => ({ id, label: PROVIDER_LABELS[id], available: this.providerAvailability.get(id) })),
      workspaces: this.knownWorkspaces(),
      workspace: this.workspace,
      workspaceWorker,
      session: this.session ? { id: this.session.id, provider: this.session.provider, worker: this.session.worker } : undefined,
      busy: this.currentTurn !== undefined || this.awaitingTurn,
      server: this.server,
      connection: this.connection,
    }
  }

  async handle(message: InboundMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.publishState()
        await this.refresh()
        return
      case 'refresh':
        await this.refresh()
        return
      case 'send':
        await this.send(message.text)
        return
      case 'cancel':
        await this.cancel()
        return
      case 'newSession':
        await this.endSession()
        this.hooks.post({ type: 'reset' })
        this.publishState()
        return
      case 'selectProvider':
        await this.select({ provider: message.provider })
        return
      case 'selectWorkspace':
        if (!this.knownWorkspaces().includes(message.workspace)) return
        await this.select({ workspace: message.workspace })
        return
      case 'decide':
        await this.decide(message.approvalId, message.decision)
        return
      case 'startServer':
        this.hooks.startServer?.()
        return
      case 'stopServer':
        this.hooks.stopServer?.()
        return
    }
  }

  /** Decide uma aprovação pendente; só `allow` explícito aprova (o agentd nega o resto). */
  async decide(approvalId: string, decision: 'allow' | 'deny'): Promise<void> {
    if (!this.api || !this.pendingApprovals.delete(approvalId)) return
    try {
      await this.api.decide(approvalId, decision)
    } catch (error) {
      if (!(error instanceof AgentApiError && error.code === 'approval_already_resolved')) {
        this.entryError(`não foi possível registrar a decisão: ${describe(error)}`)
        return
      }
    }
    this.hooks.post({ type: 'approvalResolved', approvalId, text: decision === 'allow' ? '✓ aprovado' : '✗ negado' })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.endSession()
  }

  private knownWorkspaces(): string[] {
    const remote = this.remoteWorkers.flatMap((worker) => worker.workspaces)
    return [...new Set([...this.localWorkspaces, ...remote])].sort((a, b) => a.localeCompare(b))
  }

  private async refresh(): Promise<void> {
    const api = this.api
    if (!api || this.disposed) return
    try {
      const [providers, workers] = await Promise.all([api.providers(), api.workers()])
      if (api !== this.api) return
      this.providerAvailability = new Map(
        Object.entries(providers)
          .filter(([id]) => isProviderId(id))
          .map(([id, info]) => [id as ProviderId, info.available === true]),
      )
      this.remoteWorkers = workers
      if (!this.workspace) this.workspace = this.knownWorkspaces()[0]
      this.connection = { ok: true }
    } catch (error) {
      if (api !== this.api) return
      this.connection = { ok: false, message: describe(error) }
    }
    this.publishState()
  }

  private async select(change: { provider?: ProviderId; workspace?: string }): Promise<void> {
    const provider = change.provider ?? this.provider
    const workspace = change.workspace ?? this.workspace
    if (provider === this.provider && workspace === this.workspace) return
    this.provider = provider
    this.workspace = workspace
    if (this.session) {
      await this.endSession()
      this.hooks.post({ type: 'entry', entry: { kind: 'info', text: `Nova sessão com ${PROVIDER_LABELS[provider]} em ${workspace ?? '—'}.` } })
    }
    this.publishState()
  }

  private async send(text: string): Promise<void> {
    const api = this.api
    if (!api) return this.entryError(this.connection.message ?? 'Sem conexão com o agentd')
    if (this.state.busy) return this.entryError('Há um turno em andamento; cancele ou aguarde.')
    this.hooks.post({ type: 'entry', entry: { kind: 'user', text } })
    this.awaitingTurn = true
    this.startedMessage = false
    this.lastUsage = undefined
    this.publishState()
    try {
      const session = this.session ?? (await this.openSession(api))
      const accepted = await api.sendTurn(session.id, text)
      // O SSE pode ter entregado `turn.started` antes da resposta do POST.
      if (this.awaitingTurn) this.currentTurn ??= accepted.turnId
    } catch (error) {
      this.awaitingTurn = false
      this.currentTurn = undefined
      this.entryError(describe(error))
    }
    this.publishState()
  }

  private async openSession(api: AgentApiPort): Promise<SessionInfo> {
    const workspace = this.workspace
    if (!workspace) throw new Error('Nenhum workspace configurado: rode o client:setup ou conecte um Workspace Server')
    await this.refresh()
    const workers = this.remoteWorkers.filter((worker) => worker.workspaces.includes(workspace))
    if (workers.length === 0) {
      throw new Error(`Nenhum Workspace Server conectado expõe "${workspace}". Inicie o Workspace Server.`)
    }
    if (workers.length > 1) throw new Error(`Mais de um Workspace Server expõe "${workspace}"; deixe só um conectado.`)
    const worker = workers[0]?.id ?? ''
    const session = await api.createSession({ provider: this.provider, workspace, worker })
    this.session = session
    this.lastEventId = 0
    this.hooks.post({
      type: 'entry',
      entry: { kind: 'info', text: `Sessão ${session.id}: ${PROVIDER_LABELS[this.provider]} em ${workspace} (${worker}).` },
    })
    this.consume(api, session.id)
    return session
  }

  private consume(api: AgentApiPort, sessionId: string): void {
    const stream = new AbortController()
    this.stream = stream
    void (async () => {
      try {
        for await (const event of api.events(sessionId, this.lastEventId, stream.signal)) {
          if (event.id > this.lastEventId) this.lastEventId = event.id
          this.onEvent(event)
        }
      } catch {
        // stream interrompido: tratado abaixo
      }
      if (stream.signal.aborted || this.session?.id !== sessionId) return
      this.session = undefined
      this.stream = undefined
      this.currentTurn = undefined
      this.awaitingTurn = false
      this.pendingApprovals.clear()
      this.hooks.post({ type: 'entry', entry: { kind: 'info', text: 'A sessão foi encerrada pelo agentd.' } })
      this.publishState()
    })()
  }

  private onEvent(event: AgentEvent): void {
    if (this.awaitingTurn && this.currentTurn === undefined && event.event === 'turn.started' && event.turnId) {
      this.currentTurn = event.turnId
    }
    if (this.currentTurn === undefined || event.turnId !== this.currentTurn) return
    switch (event.event) {
      case 'message.delta':
        if (!event.text) return
        if (!this.startedMessage) {
          this.startedMessage = true
          this.hooks.post({ type: 'entry', entry: { kind: 'agent', provider: PROVIDER_LABELS[event.provider] } })
        }
        this.hooks.post({ type: 'delta', text: event.text })
        return
      case 'tool.started':
        this.startedMessage = false
        this.hooks.post({ type: 'entry', entry: { kind: 'tool', label: toolLabel(event.tool, event.summary) } })
        return
      case 'tool.completed':
        if (event.status !== 'completed') {
          this.hooks.post({ type: 'entry', entry: { kind: 'tool-failed', label: toolLabel(event.tool), status: event.status ?? 'falhou' } })
        }
        return
      case 'subagent.started':
        this.hooks.post({ type: 'entry', entry: { kind: 'info', text: '⤷ subagente iniciado' } })
        return
      case 'subagent.completed':
        this.hooks.post({ type: 'entry', entry: { kind: 'info', text: '⤶ subagente concluído' } })
        return
      case 'approval.required': {
        const approvalId = event.approvalId
        if (!approvalId) return
        const label = toolLabel(event.tool, event.summary)
        this.pendingApprovals.add(approvalId)
        this.hooks.post({ type: 'approval', approvalId, label })
        this.hooks.approvalRequested?.(approvalId, label)
        return
      }
      case 'approval.resolved':
        if (!event.approvalId) return
        this.pendingApprovals.delete(event.approvalId)
        if (event.reason !== 'client') {
          this.hooks.post({
            type: 'approvalResolved',
            approvalId: event.approvalId,
            text: event.reason === 'timeout' ? '• aprovação expirada (negada)' : '• aprovação cancelada (negada)',
          })
        }
        return
      case 'usage':
        this.lastUsage = event.usage
        return
      case 'turn.completed':
      case 'turn.failed': {
        if (event.event === 'turn.failed') {
          const code = event.error?.code ?? 'erro'
          this.entryError(`turno falhou: ${code}${event.error?.message ? ` — ${event.error.message}` : ''}`)
        }
        const usage = formatUsage(this.lastUsage)
        if (usage) this.hooks.post({ type: 'entry', entry: { kind: 'usage', text: usage } })
        this.currentTurn = undefined
        this.awaitingTurn = false
        this.pendingApprovals.clear()
        this.publishState()
        return
      }
      default:
        return
    }
  }

  private async cancel(): Promise<void> {
    if (!this.api || !this.session || !this.state.busy) return
    this.hooks.post({ type: 'entry', entry: { kind: 'info', text: '⏹ cancelando o turno…' } })
    await this.api.cancel(this.session.id).catch((error: unknown) => this.entryError(describe(error)))
  }

  private async endSession(): Promise<void> {
    const session = this.session
    const api = this.api
    this.stream?.abort()
    this.stream = undefined
    this.session = undefined
    this.currentTurn = undefined
    this.awaitingTurn = false
    this.pendingApprovals.clear()
    if (session && api) await api.close(session.id).catch(() => undefined)
  }

  private entryError(text: string): void {
    this.hooks.post({ type: 'entry', entry: { kind: 'error', text } })
  }

  private publishState(): void {
    if (!this.disposed) this.hooks.post({ type: 'state', state: this.state })
  }
}
