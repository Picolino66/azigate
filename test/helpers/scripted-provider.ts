import type { AgentEventDraft } from '../../src/agents/core/agent-event.js'
import type {
  AgentInput,
  AgentProvider,
  AgentProviderHealth,
  AgentProviderId,
  AgentRuntimeSession,
  AgentSessionContext,
  AgentSessionOptions,
  ProcessExitInfo,
} from '../../src/agents/core/agent-provider.js'
import { AsyncQueue } from '../../src/agents/core/async-queue.js'

/** Runtime controlado pelo teste: eventos são empurrados manualmente. */
export class ScriptedRuntime implements AgentRuntimeSession {
  turn: AsyncQueue<AgentEventDraft> | undefined
  inputs: AgentInput[] = []
  cancelCalls = 0
  closed = false
  ignoreCancel = false
  private readonly exitListeners: ((info: ProcessExitInfo) => void)[] = []

  constructor(
    readonly context: AgentSessionContext,
    readonly options: AgentSessionOptions,
    readonly nativeSessionId: string | undefined,
    readonly model: string | undefined = undefined,
  ) {}

  startTurn(input: AgentInput): AsyncIterable<AgentEventDraft> {
    this.inputs.push(input)
    this.turn = new AsyncQueue<AgentEventDraft>()
    return this.turn
  }

  push(event: AgentEventDraft): void {
    this.turn?.push(event)
    if (event.event === 'turn.completed' || event.event === 'turn.failed') this.turn?.end()
  }

  async cancelTurn(): Promise<void> {
    this.cancelCalls += 1
    if (!this.ignoreCancel) this.push({ event: 'turn.failed', error: { code: 'turn_cancelled', message: 'cancelado' } })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.turn?.end()
    this.exit()
  }

  /** Simula a morte do processo. */
  exit(info: ProcessExitInfo = { code: 1, signal: null }): void {
    for (const listener of this.exitListeners.splice(0)) listener(info)
  }

  onExit(listener: (info: ProcessExitInfo) => void): void {
    this.exitListeners.push(listener)
  }
}

export class ScriptedProvider implements AgentProvider {
  readonly adapterVersion = '1'
  readonly protocolVersion = 'scripted-v1'
  readonly efforts = ['low', 'high'] as const
  runtimes: ScriptedRuntime[] = []
  resumeCalls: string[] = []
  failCreate = false
  resumeError: Error | undefined
  nativeId: string | undefined = 'native-1'
  health: () => Promise<AgentProviderHealth> = async () => ({ installed: true, authenticated: true, version: '9.9.9' })

  constructor(
    readonly id: AgentProviderId,
    readonly supportsRemoteWorkspace = false,
  ) {}

  get last(): ScriptedRuntime {
    const runtime = this.runtimes.at(-1)
    if (!runtime) throw new Error('nenhum runtime criado')
    return runtime
  }

  async createSession(options: AgentSessionOptions, context: AgentSessionContext): Promise<AgentRuntimeSession> {
    if (this.failCreate) throw new Error('falha simulada')
    const runtime = new ScriptedRuntime(context, options, this.nativeId)
    this.runtimes.push(runtime)
    return runtime
  }

  async resumeSession(
    nativeSessionId: string,
    options: AgentSessionOptions,
    context: AgentSessionContext,
  ): Promise<AgentRuntimeSession> {
    this.resumeCalls.push(nativeSessionId)
    if (this.resumeError) throw this.resumeError
    const runtime = new ScriptedRuntime(context, options, nativeSessionId)
    this.runtimes.push(runtime)
    return runtime
  }
}

export async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve))
}
