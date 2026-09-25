import { spawn, type ChildProcess } from 'node:child_process'
import type { ProcessExitInfo } from './agent-provider.js'
import { LineSplitter } from './ndjson.js'

/** Variáveis herdadas do agentd pelos subprocessos. Nada de segredos do gateway. */
const BASE_ENV_ALLOWLIST = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  // Necessárias para a CLI alcançar o próprio keyring e proxies corporativos.
  'DBUS_SESSION_BUS_ADDRESS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const

export function minimalEnv(
  source: NodeJS.ProcessEnv,
  extraAllowed: readonly string[] = [],
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of [...BASE_ENV_ALLOWLIST, ...extraAllowed]) {
    const value = source[name]
    if (value !== undefined && value !== '') env[name] = value
  }
  env.TERM = 'dumb'
  env.NO_COLOR = '1'
  return { ...env, ...overrides }
}

export interface ManagedProcessOptions {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  maxLineBytes: number
}

export interface ManagedProcessHandlers {
  onLine(line: string): void
  onOversizedLine?(): void
  onExit?(info: ProcessExitInfo): void
  onSpawnError?(error: Error): void
}

/**
 * Subprocesso de agente: `spawn` sem shell, argv explícito, grupo de processos próprio,
 * stdout lido como NDJSON limitado e stderr apenas contado (nunca registrado).
 */
export class ManagedProcess {
  private child: ChildProcess | undefined
  private exitInfo: ProcessExitInfo | undefined
  private readonly exitWaiters: ((info: ProcessExitInfo) => void)[] = []
  private stderrByteCount = 0

  constructor(
    private readonly options: ManagedProcessOptions,
    private readonly handlers: ManagedProcessHandlers,
  ) {}

  start(): void {
    if (this.child) throw new Error('Processo já iniciado')
    const child = spawn(this.options.command, [...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    const splitter = new LineSplitter(
      this.options.maxLineBytes,
      (line) => this.handlers.onLine(line),
      () => this.handlers.onOversizedLine?.(),
    )
    child.stdout?.on('data', (chunk: Buffer) => splitter.push(chunk))
    child.stdout?.on('end', () => splitter.flush())
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrByteCount += chunk.length
    })
    child.stdin?.on('error', () => undefined)
    child.on('error', (error) => {
      this.handlers.onSpawnError?.(error)
      this.finish({ code: null, signal: null })
    })
    child.on('close', (code, signal) => this.finish({ code, signal }))
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  get exited(): boolean {
    return this.exitInfo !== undefined
  }

  get stderrBytes(): number {
    return this.stderrByteCount
  }

  /** Escreve uma linha JSON no stdin. Retorna `false` se o processo não aceita mais entrada. */
  writeLine(payload: unknown): boolean {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed || !stdin.writable || this.exited) return false
    stdin.write(`${JSON.stringify(payload)}\n`)
    return true
  }

  closeStdin(): void {
    this.child?.stdin?.end()
  }

  /** Envia o sinal ao grupo inteiro do processo. */
  signal(signal: NodeJS.Signals): void {
    const pid = this.child?.pid
    if (pid === undefined || this.exited) return
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        this.child?.kill(signal)
      } catch {
        // Processo já terminou.
      }
    }
  }

  waitForExit(): Promise<ProcessExitInfo> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo)
    return new Promise((resolve) => this.exitWaiters.push(resolve))
  }

  /** Término escalonado: sinal inicial, depois SIGTERM e por fim SIGKILL no grupo. */
  async terminate(options: { initialSignal?: NodeJS.Signals; graceMs?: number } = {}): Promise<ProcessExitInfo> {
    if (!this.child) return { code: null, signal: null }
    if (this.exitInfo) return this.exitInfo
    const graceMs = options.graceMs ?? 3000
    const steps: NodeJS.Signals[] = [options.initialSignal ?? 'SIGTERM', 'SIGTERM', 'SIGKILL']
    for (const signal of steps) {
      if (this.exited) break
      this.signal(signal)
      const exited = await Promise.race([
        this.waitForExit().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs).unref()),
      ])
      if (exited) break
    }
    return this.exitInfo ?? { code: null, signal: 'SIGKILL' }
  }

  private finish(info: ProcessExitInfo): void {
    if (this.exitInfo) return
    this.exitInfo = info
    this.handlers.onExit?.(info)
    for (const waiter of this.exitWaiters.splice(0)) waiter(info)
  }
}
