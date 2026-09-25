import type { AgentInput, AgentSessionContext } from '../core/agent-provider.js'
import { parseJsonLine } from '../core/ndjson.js'
import { AgentResumeError, AgentStartError, ProcessBackedSession } from '../core/process-session.js'
import { AgyEventMapper } from './agy-events.js'

export interface AgyLaunch {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  expectedConversationId?: string
  model?: string
  initTimeoutMs: number
  interruptGraceMs: number
}

/**
 * Sessão AGY headless em `stream-json`: um processo vivo, uma linha `{"event":"user"}` por
 * turno. O AGY não aceita mensagens de controle na entrada, então o cancelamento é por
 * `SIGINT` no grupo de processos e a sessão é retomada depois com `--conversation`.
 */
export class AgySession extends ProcessBackedSession {
  private readonly mapper = new AgyEventMapper()
  private initWaiter: ((conversationId: string | undefined) => void) | undefined

  private constructor(
    context: AgentSessionContext,
    private readonly launchOptions: AgyLaunch,
  ) {
    super(context)
    this.currentModel = launchOptions.model
    this.onExit(() => this.initWaiter?.(undefined))
  }

  static async start(context: AgentSessionContext, options: AgyLaunch): Promise<AgySession> {
    const session = new AgySession(context, options)
    const initialized = new Promise<string | undefined>((resolve) => {
      session.initWaiter = resolve
      setTimeout(() => resolve(undefined), options.initTimeoutMs).unref()
    })
    session.launch({ command: options.command, args: options.args, cwd: options.cwd, env: options.env })
    const conversationId = await initialized
    session.initWaiter = undefined
    if (!conversationId) {
      await session.close()
      throw new AgentStartError('O AGY não informou a conversa no evento init')
    }
    if (options.expectedConversationId && conversationId !== options.expectedConversationId) {
      // O AGY cria uma conversa nova, em silêncio, quando o ID pedido não existe.
      await session.close()
      throw new AgentResumeError('O AGY não encontrou a conversa a retomar')
    }
    session.currentNativeSessionId = conversationId
    return session
  }

  protected sendTurn(input: AgentInput): void {
    this.mapper.resetTurn()
    const accepted = this.process?.writeLine({ event: 'user', message: { role: 'user', content: input.text } })
    if (!accepted) throw new Error('stdin fechado')
  }

  protected requestInterrupt(): void {
    const managed = this.process
    if (!managed) return
    managed.signal('SIGINT')
    setTimeout(() => {
      if (!managed.exited) void managed.terminate({ initialSignal: 'SIGTERM' })
    }, this.launchOptions.interruptGraceMs).unref()
  }

  protected handleLine(line: string): void {
    const parsed = parseJsonLine(line)
    if (parsed === undefined) {
      this.context.diagnostic('agent_invalid_line', { provider: 'agy' })
      return
    }
    const mapped = this.mapper.map(parsed)
    switch (mapped.kind) {
      case 'init':
        this.initWaiter?.(mapped.conversationId)
        for (const event of mapped.events) this.emitTurn(event)
        return
      case 'events':
        for (const event of mapped.events) this.emitTurn(event)
        return
      case 'terminal':
        for (const event of mapped.events) this.emitTurn(event)
        if (!this.activeTurn) return
        if (this.turnCancelRequested) {
          this.finishTurn(this.failure('turn_cancelled', 'Turno cancelado', mapped.native))
        } else if (mapped.success) {
          this.finishTurn(
            mapped.output === undefined
              ? { event: 'turn.completed', native: mapped.native }
              : { event: 'turn.completed', output: mapped.output, native: mapped.native },
          )
        } else {
          this.finishTurn(this.failure('agent_turn_failed', 'O agente terminou o turno com erro', mapped.native))
        }
        return
      case 'invalid':
        this.context.diagnostic('agent_invalid_message', { provider: 'agy' })
    }
  }
}
