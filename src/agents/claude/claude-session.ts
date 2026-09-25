import type { AgentInput, AgentSessionContext } from '../core/agent-provider.js'
import { parseJsonLine } from '../core/ndjson.js'
import { AgentStartError, ProcessBackedSession } from '../core/process-session.js'
import { ClaudeEventMapper, summarizeToolInput } from './claude-events.js'

export interface ClaudeLaunch {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  nativeSessionId: string
  model?: string
  handshakeTimeoutMs: number
  interruptGraceMs: number
}

interface PendingControl {
  resolve(success: boolean): void
  timer: NodeJS.Timeout
}

/**
 * Sessão Claude Code em `stream-json` bidirecional. Usa o protocolo de controle do CLI:
 * `initialize` como handshake (sem chamada de modelo), `can_use_tool` para aprovações e
 * `interrupt` para cancelamento. Respostas de controle nunca viram eventos públicos,
 * porque o `initialize` devolve dados da conta.
 */
export class ClaudeSession extends ProcessBackedSession {
  private readonly mapper = new ClaudeEventMapper()
  private readonly pendingControls = new Map<string, PendingControl>()
  private readonly permissionAborts = new Map<string, AbortController>()
  private controlSequence = 0

  private constructor(
    context: AgentSessionContext,
    private readonly launchOptions: ClaudeLaunch,
  ) {
    super(context)
    this.currentNativeSessionId = launchOptions.nativeSessionId
    this.currentModel = launchOptions.model
    this.onExit(() => {
      for (const pending of this.pendingControls.values()) {
        clearTimeout(pending.timer)
        pending.resolve(false)
      }
      this.pendingControls.clear()
      for (const controller of this.permissionAborts.values()) controller.abort()
    })
  }

  static async start(context: AgentSessionContext, options: ClaudeLaunch): Promise<ClaudeSession> {
    const session = new ClaudeSession(context, options)
    session.launch({ command: options.command, args: options.args, cwd: options.cwd, env: options.env })
    const ready = await session.control({ subtype: 'initialize' }, options.handshakeTimeoutMs)
    if (!ready) {
      await session.close()
      throw new AgentStartError('O Claude Code não concluiu o handshake de inicialização')
    }
    return session
  }

  protected sendTurn(input: AgentInput): void {
    this.mapper.resetTurn()
    const accepted = this.process?.writeLine({
      type: 'user',
      session_id: '',
      message: { role: 'user', content: [{ type: 'text', text: input.text }] },
      parent_tool_use_id: null,
    })
    if (!accepted) throw new Error('stdin fechado')
  }

  protected async requestInterrupt(): Promise<void> {
    for (const controller of this.permissionAborts.values()) controller.abort()
    const acknowledged = await this.control({ subtype: 'interrupt' }, this.launchOptions.interruptGraceMs)
    if (!acknowledged) throw new Error('interrupt sem confirmação')
    // O CLI encerra o turno com `result`; se não o fizer, o processo é derrubado.
    const turn = this.activeTurn
    setTimeout(() => {
      if (turn && this.activeTurn === turn) void this.process?.terminate({ initialSignal: 'SIGINT' })
    }, this.launchOptions.interruptGraceMs).unref()
  }

  protected handleLine(line: string): void {
    const parsed = parseJsonLine(line)
    if (parsed === undefined) {
      this.context.diagnostic('agent_invalid_line', { provider: 'claude' })
      return
    }
    const mapped = this.mapper.map(parsed)
    switch (mapped.kind) {
      case 'events':
        for (const event of mapped.events) this.emitTurn(event)
        return
      case 'terminal': {
        for (const event of mapped.events) this.emitTurn(event)
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
      }
      case 'permission_request':
        void this.answerPermission(mapped.requestId, mapped.tool, mapped.input, mapped.native)
        return
      case 'unsupported_control_request':
        this.process?.writeLine({
          type: 'control_response',
          response: { subtype: 'error', request_id: mapped.requestId, error: 'Não suportado pelo Azigate' },
        })
        return
      case 'control_cancel':
        this.permissionAborts.get(mapped.requestId)?.abort()
        return
      case 'control_response': {
        const pending = this.pendingControls.get(mapped.requestId)
        if (!pending) return
        this.pendingControls.delete(mapped.requestId)
        clearTimeout(pending.timer)
        pending.resolve(mapped.success)
        return
      }
      case 'ignored':
        return
      case 'invalid':
        this.context.diagnostic('agent_invalid_message', { provider: 'claude' })
    }
  }

  private async answerPermission(requestId: string, tool: string, input: unknown, native: unknown): Promise<void> {
    const controller = new AbortController()
    this.permissionAborts.set(requestId, controller)
    let decision: 'allow' | 'deny'
    try {
      decision = await this.context.requestApproval({
        tool,
        summary: summarizeToolInput(tool, input),
        native,
        signal: controller.signal,
      })
    } catch {
      decision = 'deny'
    } finally {
      this.permissionAborts.delete(requestId)
    }
    if (controller.signal.aborted) return
    const response =
      decision === 'allow'
        ? { behavior: 'allow', updatedInput: input ?? {} }
        : { behavior: 'deny', message: 'Negado pelo operador no Azigate' }
    this.process?.writeLine({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    })
  }

  private control(request: Record<string, unknown>, timeoutMs: number): Promise<boolean> {
    const requestId = `azg_${++this.controlSequence}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(requestId)
        resolve(false)
      }, timeoutMs)
      timer.unref()
      this.pendingControls.set(requestId, { resolve, timer })
      const written = this.process?.writeLine({ type: 'control_request', request_id: requestId, request })
      if (!written) {
        clearTimeout(timer)
        this.pendingControls.delete(requestId)
        resolve(false)
      }
    })
  }
}
