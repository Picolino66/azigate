import type { AgentEvent, AgentUsage } from '../agents/core/agent-event.js'
import { AsyncQueue } from '../agents/core/async-queue.js'
import { AgentApiError, type AgentApi, type SessionInfo } from './api.js'
import { PROVIDER_NAMES, formatUsage, renderEvent, toolLabel } from './render.js'

export interface ChatIo {
  write(text: string): void
  /** Lê uma linha; `null` em fim de entrada. */
  ask(prompt: string): Promise<string | null>
  /** Registra o tratamento de Ctrl+C. */
  onInterrupt(handler: () => void): void
}

export interface ChatOptions {
  provider: string
  workspace: string
  worker?: string
  local?: boolean
  model?: string
  effort?: string
  mode?: string
  resume?: string
  keep?: boolean
  reasoning?: boolean
}

type Signal =
  | { kind: 'approval'; event: AgentEvent }
  | { kind: 'turn-end'; event: AgentEvent }
  | { kind: 'closed' }

/**
 * Chat de terminal sobre a Agent API: cria (ou retoma) a sessão, mostra o streaming com
 * ferramentas e aprovações, pergunta y/N, aceita vários turnos e encerra (ADR-025).
 */
export class ChatController {
  private readonly signals = new AsyncQueue<Signal>()
  private readonly signalIterator = this.signals[Symbol.asyncIterator]()
  private awaitingTurn = false
  private readonly abort = new AbortController()
  private session: SessionInfo | undefined
  private currentTurn: string | undefined
  private startedMessage = false
  private lastUsage: AgentUsage | undefined
  private interrupts = 0

  constructor(
    private readonly api: AgentApi,
    private readonly io: ChatIo,
    private readonly options: ChatOptions,
  ) {}

  async run(): Promise<number> {
    try {
      this.session = await this.openSession()
    } catch (error) {
      this.io.write(`erro: ${describe(error)}\n`)
      return 1
    }
    const session = this.session
    this.io.write(
      [
        `provider: ${session.provider}`,
        `agent host: ${this.api.host}`,
        `workspace host: ${session.worker ?? `${this.api.host} (local)`}`,
        `workspace: ${session.workspace}`,
        `sessão: ${session.id}`,
        '',
        'Comandos: /cancelar, /sair. Ctrl+C cancela o turno em andamento.',
        '',
      ].join('\n'),
    )
    void this.consume(session.id)
    this.io.onInterrupt(() => this.interrupt())
    let exitCode = 0
    try {
      for (;;) {
        const line = await this.io.ask('> ')
        if (line === null) break
        const input = line.trim()
        if (input === '') continue
        if (input === '/sair' || input === '/exit' || input === '/quit') break
        if (input === '/cancelar' || input === '/cancel') {
          this.io.write('  (nenhum turno em andamento)\n')
          continue
        }
        this.startedMessage = false
        this.lastUsage = undefined
        this.interrupts = 0
        this.awaitingTurn = true
        const accepted = await this.api.sendTurn(session.id, input)
        this.currentTurn ??= accepted.turnId
        const ended = await this.waitTurn()
        this.currentTurn = undefined
        this.awaitingTurn = false
        if (!ended) {
          exitCode = 1
          break
        }
      }
    } catch (error) {
      this.io.write(`\nerro: ${describe(error)}\n`)
      exitCode = 1
    } finally {
      this.abort.abort()
      if (!this.options.keep) await this.api.close(session.id).catch(() => undefined)
      this.io.write(this.options.keep ? `sessão mantida: ${session.id}\n` : 'sessão encerrada.\n')
    }
    return exitCode
  }

  private async openSession(): Promise<SessionInfo> {
    if (this.options.resume) return this.api.session(this.options.resume)
    const worker = this.options.local ? undefined : (this.options.worker ?? (await this.findWorker()))
    const body: Record<string, unknown> = { provider: this.options.provider, workspace: this.options.workspace }
    if (worker) body.worker = worker
    if (this.options.model) body.model = this.options.model
    if (this.options.effort) body.effort = this.options.effort
    if (this.options.mode) body.permissionMode = this.options.mode
    return this.api.createSession(body)
  }

  private async findWorker(): Promise<string> {
    const workers = (await this.api.workers()).filter((worker) => worker.workspaces.includes(this.options.workspace))
    if (workers.length === 1 && workers[0]) return workers[0].id
    if (workers.length > 1) throw new Error(`mais de um Workspace Server expõe "${this.options.workspace}"; use --worker`)
    throw new Error(`nenhum Workspace Server conectado expõe "${this.options.workspace}" (use --local para um workspace da máquina do agente)`)
  }

  private async consume(sessionId: string): Promise<void> {
    try {
      for await (const event of this.api.events(sessionId, 0, this.abort.signal)) this.handle(event)
    } catch {
      // stream encerrado
    }
    this.signals.push({ kind: 'closed' })
  }

  private handle(event: AgentEvent): void {
    // O SSE pode entregar o início do turno antes da resposta do POST.
    if (this.awaitingTurn && this.currentTurn === undefined && event.event === 'turn.started' && event.turnId) {
      this.currentTurn = event.turnId
    }
    const inTurn = this.currentTurn !== undefined && event.turnId === this.currentTurn
    if (!inTurn) return
    if (event.event === 'message.delta' && !this.startedMessage) {
      this.startedMessage = true
      this.io.write(`\n${PROVIDER_NAMES[event.provider] ?? event.provider}:\n`)
    }
    if (event.event === 'usage') this.lastUsage = event.usage
    const text = renderEvent(event, { reasoning: this.options.reasoning ?? false })
    if (text) this.io.write(text)
    if (event.event === 'approval.required') this.signals.push({ kind: 'approval', event })
    if (event.event === 'turn.completed' || event.event === 'turn.failed') this.signals.push({ kind: 'turn-end', event })
  }

  /** Espera o fim do turno respondendo às aprovações. `false` se a sessão acabou. */
  private async waitTurn(): Promise<boolean> {
    for (;;) {
      const next = await this.signalIterator.next()
      if (next.done) return false
      const signal = next.value
      if (signal.kind === 'closed') return false
      if (signal.kind === 'turn-end') {
        const usage = formatUsage(this.lastUsage)
        this.io.write(`\n${usage ? `  (${usage})\n` : ''}`)
        return true
      }
      const approval = signal.event
      const answer = await this.io.ask(`\n  ⚠ Aprovar ${toolLabel(approval.tool, approval.summary)}? [y/N] `)
      const decision = answer !== null && /^(y|s|sim|yes)$/iu.test(answer.trim()) ? 'allow' : 'deny'
      await this.api.decide(approval.approvalId ?? '', decision).catch((error: unknown) => {
        if (!(error instanceof AgentApiError) || error.code !== 'approval_already_resolved') throw error
      })
      this.io.write(decision === 'allow' ? '  ✓ aprovado\n' : '  ✗ negado\n')
    }
  }

  private interrupt(): void {
    const session = this.session
    if (session && this.currentTurn) {
      this.interrupts += 1
      if (this.interrupts === 1) {
        this.io.write('\n  ⏹ cancelando o turno… (Ctrl+C de novo para sair)\n')
        void this.api.cancel(session.id).catch(() => undefined)
        return
      }
    }
    this.signals.push({ kind: 'closed' })
  }
}

function describe(error: unknown): string {
  if (error instanceof AgentApiError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : 'erro desconhecido'
}
