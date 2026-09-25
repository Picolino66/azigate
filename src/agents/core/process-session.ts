import type { AgentEventDraft, TurnFailureCode } from './agent-event.js'
import type {
  AgentInput,
  AgentRuntimeSession,
  AgentSessionContext,
  ProcessExitInfo,
} from './agent-provider.js'
import { AsyncQueue } from './async-queue.js'
import { ManagedProcess, type ManagedProcessOptions } from './process.js'

interface ActiveTurn {
  id: string
  queue: AsyncQueue<AgentEventDraft>
  cancelRequested: boolean
}

export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024

export class AgentStartError extends Error {
  override readonly name = 'AgentStartError'
}

/** A CLI subiu, mas não retomou a sessão nativa pedida (contexto perdido). */
export class AgentResumeError extends Error {
  override readonly name = 'AgentResumeError'
}

/**
 * Base das sessões apoiadas em um subprocesso de longa duração. Cuida do ciclo de vida do
 * processo, de um turno por vez e do encerramento do turno quando o processo morre. As
 * subclasses traduzem as mensagens nativas.
 */
export abstract class ProcessBackedSession implements AgentRuntimeSession {
  protected process: ManagedProcess | undefined
  protected activeTurn: ActiveTurn | undefined
  private readonly exitListeners: ((info: ProcessExitInfo) => void)[] = []
  private closing = false
  protected currentNativeSessionId: string | undefined
  protected currentModel: string | undefined

  protected constructor(protected readonly context: AgentSessionContext) {}

  get nativeSessionId(): string | undefined {
    return this.currentNativeSessionId
  }

  get model(): string | undefined {
    return this.currentModel
  }

  protected launch(options: Omit<ManagedProcessOptions, 'maxLineBytes'> & { maxLineBytes?: number }): void {
    const managed = new ManagedProcess(
      { ...options, maxLineBytes: options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES },
      {
        onLine: (line) => this.handleLine(line),
        onOversizedLine: () => this.context.diagnostic('agent_line_oversized'),
        onSpawnError: (error) => this.context.diagnostic('agent_spawn_error', { error: error.name }),
        onExit: (info) => this.handleExit(info),
      },
    )
    this.process = managed
    managed.start()
  }

  protected abstract handleLine(line: string): void

  /** Envia a entrada do turno ao processo. Deve lançar se o processo não aceitar entrada. */
  protected abstract sendTurn(input: AgentInput): void | Promise<void>

  /** Pede interrupção pelo protocolo nativo; a base cuida do fallback por sinal. */
  protected abstract requestInterrupt(): void | Promise<void>

  startTurn(input: AgentInput): AsyncIterable<AgentEventDraft> {
    const queue = new AsyncQueue<AgentEventDraft>()
    if (this.activeTurn) {
      queue.push(this.failure('agent_protocol_error', 'Já existe um turno em andamento'))
      queue.end()
      return queue
    }
    if (!this.process || this.process.exited) {
      queue.push(this.failure('agent_process_exited', 'O processo do agente não está em execução'))
      queue.end()
      return queue
    }
    this.activeTurn = { id: input.turnId, queue, cancelRequested: false }
    Promise.resolve()
      .then(() => this.sendTurn(input))
      .catch(() => this.finishTurn(this.failure('agent_protocol_error', 'Falha ao enviar o turno ao agente')))
    return queue
  }

  async cancelTurn(): Promise<void> {
    const turn = this.activeTurn
    if (!turn || turn.cancelRequested) return
    turn.cancelRequested = true
    try {
      await this.requestInterrupt()
    } catch {
      await this.process?.terminate({ initialSignal: 'SIGINT' })
    }
  }

  get turnCancelRequested(): boolean {
    return this.activeTurn?.cancelRequested ?? false
  }

  async close(): Promise<void> {
    this.closing = true
    const managed = this.process
    if (!managed || managed.exited) return
    managed.closeStdin()
    await managed.terminate({ initialSignal: 'SIGTERM', graceMs: 3000 })
  }

  onExit(listener: (info: ProcessExitInfo) => void): void {
    this.exitListeners.push(listener)
  }

  protected emitTurn(event: AgentEventDraft): void {
    if (this.activeTurn) this.activeTurn.queue.push(event)
    else this.context.emit(event)
  }

  /** Emite o evento terminal e libera o slot de turno. */
  protected finishTurn(event: AgentEventDraft): void {
    const turn = this.activeTurn
    if (!turn) return
    this.activeTurn = undefined
    turn.queue.push(event)
    turn.queue.end()
  }

  protected failure(code: TurnFailureCode, message: string, native?: unknown): AgentEventDraft {
    return native === undefined
      ? { event: 'turn.failed', error: { code, message } }
      : { event: 'turn.failed', error: { code, message }, native }
  }

  private handleExit(info: ProcessExitInfo): void {
    if (this.activeTurn) {
      const cancelled = this.activeTurn.cancelRequested
      this.finishTurn(
        cancelled
          ? this.failure('turn_cancelled', 'Turno cancelado')
          : this.failure('agent_process_exited', 'O processo do agente terminou durante o turno'),
      )
    }
    this.context.diagnostic('agent_process_exit', {
      code: info.code ?? -1,
      signal: info.signal ?? 'none',
      expected: this.closing,
      stderrBytes: this.process?.stderrBytes ?? 0,
    })
    for (const listener of this.exitListeners.splice(0)) listener(info)
  }
}
