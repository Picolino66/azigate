import { isRecord, stringField } from '../core/agent-event.js'
import type { AgentInput, AgentSessionContext } from '../core/agent-provider.js'
import { JsonRpcConnection, type JsonRpcId } from '../core/json-rpc.js'
import { parseJsonLine } from '../core/ndjson.js'
import { AgentResumeError, AgentStartError, ProcessBackedSession } from '../core/process-session.js'
import { CodexEventMapper, codexApprovalRequest } from './codex-events.js'

export interface CodexThreadSettings {
  cwd: string
  approvalPolicy: 'untrusted' | 'on-request'
  sandbox: 'read-only' | 'workspace-write'
  model?: string
  effort?: string
}

export interface CodexLaunch {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  thread: CodexThreadSettings
  resumeThreadId?: string
  clientVersion: string
  requestTimeoutMs: number
}

/**
 * Sessão Codex sobre `codex app-server` por stdio. A thread nativa é a sessão; cada turno é
 * `turn/start`; cancelamento é `turn/interrupt`; pedidos de aprovação do servidor viram
 * aprovações do Azigate e os demais pedidos do servidor são recusados.
 */
export class CodexSession extends ProcessBackedSession {
  private readonly mapper = new CodexEventMapper()
  private readonly rpc: JsonRpcConnection
  private threadId: string | undefined
  private codexTurnId: string | undefined

  private constructor(
    context: AgentSessionContext,
    private readonly launchOptions: CodexLaunch,
  ) {
    super(context)
    this.rpc = new JsonRpcConnection((message) => this.process?.writeLine(message) ?? false, {
      onNotification: (method, params, raw) => this.handleNotification(method, params, raw),
      onServerRequest: (id, method, params, raw) => void this.handleServerRequest(id, method, params, raw),
      onInvalidMessage: () => this.context.diagnostic('agent_invalid_message', { provider: 'codex' }),
    })
    this.onExit(() => this.rpc.close())
  }

  static async start(context: AgentSessionContext, options: CodexLaunch): Promise<CodexSession> {
    const session = new CodexSession(context, options)
    session.launch({ command: options.command, args: options.args, cwd: options.cwd, env: options.env })
    try {
      await session.initialize()
    } catch (error) {
      await session.close()
      if (error instanceof AgentResumeError) throw error
      throw new AgentStartError('O Codex app-server não concluiu a inicialização')
    }
    return session
  }

  private async initialize(): Promise<void> {
    const timeout = this.launchOptions.requestTimeoutMs
    await this.rpc.request(
      'initialize',
      {
        clientInfo: { name: 'azigate', title: 'Azigate Agent Plane', version: this.launchOptions.clientVersion },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
      timeout,
    )
    this.rpc.notify('initialized')
    const settings = this.launchOptions.thread
    const threadParams: Record<string, unknown> = {
      cwd: settings.cwd,
      approvalPolicy: settings.approvalPolicy,
      sandbox: settings.sandbox,
    }
    if (settings.model) threadParams.model = settings.model
    let result: unknown
    if (this.launchOptions.resumeThreadId) {
      try {
        result = await this.rpc.request('thread/resume', { ...threadParams, threadId: this.launchOptions.resumeThreadId }, timeout)
      } catch {
        throw new AgentResumeError('O Codex não encontrou a thread a retomar')
      }
    } else {
      result = await this.rpc.request('thread/start', threadParams, timeout)
    }
    const record = isRecord(result) ? result : {}
    const thread = isRecord(record.thread) ? record.thread : {}
    const threadId = stringField(thread, 'id')
    if (!threadId) throw new AgentStartError('Resposta de thread sem identificador')
    if (this.launchOptions.resumeThreadId && threadId !== this.launchOptions.resumeThreadId) {
      throw new AgentResumeError('O Codex retomou uma thread diferente da pedida')
    }
    this.threadId = threadId
    this.currentNativeSessionId = threadId
    this.currentModel = stringField(record, 'model') ?? settings.model
    const started: Parameters<AgentSessionContext['emit']>[0] = { event: 'session.started', nativeSessionId: threadId, native: result }
    if (this.currentModel) started.model = this.currentModel
    this.context.emit(started)
  }

  protected async sendTurn(input: AgentInput): Promise<void> {
    this.mapper.resetTurn()
    this.codexTurnId = undefined
    const params: Record<string, unknown> = {
      threadId: this.threadId,
      input: [{ type: 'text', text: input.text, text_elements: [] }],
    }
    if (this.launchOptions.thread.effort) params.effort = this.launchOptions.thread.effort
    const result = await this.rpc.request('turn/start', params, this.launchOptions.requestTimeoutMs)
    const turn = isRecord(result) && isRecord(result.turn) ? result.turn : {}
    this.codexTurnId ??= stringField(turn, 'id')
  }

  protected async requestInterrupt(): Promise<void> {
    if (!this.threadId || !this.codexTurnId) throw new Error('turno nativo ainda não identificado')
    await this.rpc.request(
      'turn/interrupt',
      { threadId: this.threadId, turnId: this.codexTurnId },
      this.launchOptions.requestTimeoutMs,
    )
  }

  protected handleLine(line: string): void {
    const parsed = parseJsonLine(line)
    if (parsed === undefined) {
      this.context.diagnostic('agent_invalid_line', { provider: 'codex' })
      return
    }
    this.rpc.handleMessage(parsed)
  }

  private handleNotification(method: string, params: unknown, raw: Record<string, unknown>): void {
    const record = isRecord(params) ? params : {}
    const threadId = stringField(record, 'threadId')
    if (threadId && this.threadId && threadId !== this.threadId) return
    if (method === 'turn/started' && isRecord(record.turn)) {
      this.codexTurnId ??= stringField(record.turn, 'id')
    }
    const mapped = this.mapper.map(method, params, raw)
    if (mapped.kind === 'events') {
      for (const event of mapped.events) this.emitTurn(event)
      return
    }
    if (!this.activeTurn) {
      this.context.emit({ event: 'provider.event', native: mapped.native })
      return
    }
    const output = this.mapper.output
    if (mapped.status === 'completed' && !this.turnCancelRequested) {
      this.finishTurn(
        output === undefined
          ? { event: 'turn.completed', native: mapped.native }
          : { event: 'turn.completed', output, native: mapped.native },
      )
    } else if (mapped.status === 'interrupted' || this.turnCancelRequested) {
      this.finishTurn(this.failure('turn_cancelled', 'Turno cancelado', mapped.native))
    } else {
      this.finishTurn(this.failure('agent_turn_failed', 'O agente terminou o turno com erro', mapped.native))
    }
  }

  private async handleServerRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
    raw: Record<string, unknown>,
  ): Promise<void> {
    const approval = codexApprovalRequest(method, params)
    if (!approval) {
      this.rpc.respondError(id, -32601, 'Método não suportado pelo Azigate')
      this.emitTurn({ event: 'provider.event', native: raw })
      return
    }
    let decision: 'allow' | 'deny'
    try {
      decision = await this.context.requestApproval({ tool: approval.tool, summary: approval.summary, native: raw })
    } catch {
      decision = 'deny'
    }
    this.rpc.respond(id, approval.respond(decision))
  }
}
