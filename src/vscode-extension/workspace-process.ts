import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { isAbsolute } from 'node:path'
import type { ServerStatus } from './protocol.js'

export const DEFAULT_SERVER_COMMAND = 'azigate-workspace'

const BARE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const MAX_LOG_LINE = 2000
const STOP_GRACE_MS = 5000

// O Workspace Server lê a configuração de ~/.config/azigate; o resto do ambiente do editor
// (tokens, chaves de outras ferramentas) não é repassado.
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'AZIGATE_CONFIG_DIR',
  'NODE_EXTRA_CA_CERTS',
  'SystemRoot',
  'USERPROFILE',
  'APPDATA',
] as const

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface WorkspaceProcessHooks {
  onStatus(status: ServerStatus, detail?: string): void
  onLog(line: string): void
}

/**
 * Programa do Workspace Server: nome simples resolvido pelo PATH ou caminho absoluto. Nada de
 * shell, argumentos ou valores começando com `-` (a configuração é de escopo `machine`).
 */
export function validateServerCommand(raw: string | undefined): string {
  const command = raw?.trim() || DEFAULT_SERVER_COMMAND
  if (command.startsWith('-')) throw new Error('O comando do Workspace Server não pode começar com "-"')
  if (isAbsolute(command)) return command
  if (!BARE_COMMAND.test(command)) {
    throw new Error('O comando do Workspace Server deve ser um nome de programa ou um caminho absoluto, sem argumentos')
  }
  return command
}

export function minimalEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const name of ENV_ALLOWLIST) {
    const value = env[name]
    if (value !== undefined) result[name] = value
  }
  return result
}

/**
 * Inicia e para o `azigate-workspace` local, sem shell e sem argumentos: ele usa o
 * `workspace.json` do `client:setup`. A saída vai linha a linha para o canal de log local.
 */
export class WorkspaceServerProcess {
  private child: ChildProcess | undefined
  private killTimer: NodeJS.Timeout | undefined
  private stopping = false

  constructor(
    private readonly hooks: WorkspaceProcessHooks,
    private readonly spawn: SpawnFn = nodeSpawn,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get running(): boolean {
    return this.child !== undefined
  }

  start(rawCommand: string | undefined): void {
    if (this.child) return
    let command: string
    try {
      command = validateServerCommand(rawCommand)
    } catch (error) {
      this.hooks.onStatus('failed', error instanceof Error ? error.message : 'comando inválido')
      return
    }
    this.stopping = false
    this.hooks.onStatus('starting')
    let child: ChildProcess
    try {
      child = this.spawn(command, [], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: minimalEnv(this.env),
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
    } catch (error) {
      this.hooks.onStatus('failed', error instanceof Error ? error.message : 'falha ao iniciar')
      return
    }
    this.child = child
    this.pipe(child.stdout)
    this.pipe(child.stderr)
    child.once('spawn', () => {
      if (this.child === child) this.hooks.onStatus('running')
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (this.child !== child) return
      this.child = undefined
      const detail = error.code === 'ENOENT' ? `"${command}" não encontrado; instale o azigate-client` : error.message
      this.hooks.onStatus('failed', detail)
    })
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      if (this.killTimer) clearTimeout(this.killTimer)
      if (this.stopping) this.hooks.onStatus('stopped')
      else this.hooks.onStatus('failed', `encerrou (${signal ?? `código ${code ?? '?'}`})`)
    })
  }

  /** SIGTERM no grupo de processos e SIGKILL depois de 5 s. */
  stop(): void {
    const child = this.child
    if (!child) return
    this.stopping = true
    this.signal(child, 'SIGTERM')
    this.killTimer = setTimeout(() => this.signal(child, 'SIGKILL'), STOP_GRACE_MS)
    this.killTimer.unref()
  }

  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch {
      // processo já encerrado
    }
  }

  private pipe(stream: NodeJS.ReadableStream | null | undefined): void {
    if (!stream) return
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        this.emit(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
      if (buffer.length > MAX_LOG_LINE) {
        this.emit(buffer)
        buffer = ''
      }
    })
    stream.on('end', () => {
      if (buffer) this.emit(buffer)
      buffer = ''
    })
  }

  private emit(line: string): void {
    const text = line.replace(/\r$/u, '')
    if (text) this.hooks.onLog(text.length > MAX_LOG_LINE ? `${text.slice(0, MAX_LOG_LINE)}…` : text)
  }
}
