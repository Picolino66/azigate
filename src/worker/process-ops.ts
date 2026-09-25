import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { minimalEnv } from '../agents/core/process.js'
import { WorkerRpcError } from '../worker-protocol/protocol.js'
import { resolveInside } from './jail.js'

export const OUTPUT_LIMIT_BYTES = 1024 * 1024
const MAX_PROCESSES = 4
const MAX_ARGS = 256
const MAX_ARG_BYTES = 32 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const KILL_GRACE_MS = 2000

export interface ExecPolicy {
  enabled: boolean
  allowedCommands?: ReadonlySet<string>
}

type Params = Record<string, unknown>

export function validateArgv(value: unknown, policy: ExecPolicy): string[] {
  if (!policy.enabled) throw new WorkerRpcError('exec_disabled', 'Execução desabilitada neste worker')
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARGS) {
    throw new WorkerRpcError('invalid_params', 'argv deve ser uma lista não vazia de textos')
  }
  for (const item of value) {
    if (typeof item !== 'string' || item.includes('\0') || Buffer.byteLength(item) > MAX_ARG_BYTES) {
      throw new WorkerRpcError('invalid_params', 'argv contém um argumento inválido')
    }
  }
  const argv = value as string[]
  const program = argv[0] ?? ''
  if (program.length === 0) throw new WorkerRpcError('invalid_params', 'argv[0] não pode ser vazio')
  if (policy.allowedCommands && !policy.allowedCommands.has(program)) {
    throw new WorkerRpcError('command_not_allowed', 'Programa fora da allowlist do worker')
  }
  return argv
}

/** Ambiente dos processos do workspace: mínimo, sem segredos do worker. */
export function workspaceEnv(): NodeJS.ProcessEnv {
  return minimalEnv(process.env, [], { CI: '1', GIT_TERMINAL_PROMPT: '0' })
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

class BoundedOutput {
  private chunks: Buffer[] = []
  private size = 0
  truncated = false

  push(chunk: Buffer): void {
    if (this.size >= OUTPUT_LIMIT_BYTES) {
      this.truncated = true
      return
    }
    const room = OUTPUT_LIMIT_BYTES - this.size
    const piece = chunk.length > room ? chunk.subarray(0, room) : chunk
    if (piece.length < chunk.length) this.truncated = true
    this.chunks.push(piece)
    this.size += piece.length
  }

  text(): string {
    return Buffer.concat(this.chunks, this.size).toString('utf8')
  }
}

export async function shellExec(root: string, params: Params, policy: ExecPolicy): Promise<unknown> {
  const argv = validateArgv(params.argv, policy)
  const cwd = resolveInside(root, params.cwd)
  const rawTimeout = params.timeoutMs
  if (rawTimeout !== undefined && (typeof rawTimeout !== 'number' || !Number.isSafeInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > MAX_TIMEOUT_MS)) {
    throw new WorkerRpcError('invalid_params', `timeoutMs deve ficar entre 1 e ${MAX_TIMEOUT_MS}`)
  }
  const timeoutMs = rawTimeout ?? DEFAULT_TIMEOUT_MS
  const stdin = params.stdin
  if (stdin !== undefined && typeof stdin !== 'string') throw new WorkerRpcError('invalid_params', 'stdin deve ser texto')
  const [program, ...args] = argv as [string, ...string[]]
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: workspaceEnv(), shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = new BoundedOutput()
    const stderr = new BoundedOutput()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child, 'SIGTERM')
      setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS).unref()
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.stdin.on('error', () => undefined)
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(
        error.code === 'ENOENT'
          ? new WorkerRpcError('not_found', 'Programa não encontrado')
          : new WorkerRpcError('io_error', 'Falha ao iniciar o programa'),
      )
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        exitCode: code,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
      })
    })
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

interface ManagedProcessEntry {
  child: ChildProcess
  output: Buffer[]
  /** Posição absoluta do primeiro byte ainda guardado em `output`. */
  base: number
  size: number
  exitCode: number | null
  running: boolean
}

/** Processos de longa duração por workspace, com saída combinada em buffer circular. */
export class ProcessRegistry {
  private readonly processes = new Map<string, ManagedProcessEntry>()

  constructor(private readonly policy: ExecPolicy) {}

  start(root: string, params: Params): unknown {
    const argv = validateArgv(params.argv, this.policy)
    const cwd = resolveInside(root, params.cwd)
    const running = [...this.processes.values()].filter((entry) => entry.running).length
    if (running >= MAX_PROCESSES) throw new WorkerRpcError('process_limit', 'Limite de processos simultâneos atingido')
    const [program, ...args] = argv as [string, ...string[]]
    const child = spawn(program, args, { cwd, env: workspaceEnv(), shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const id = `proc_${randomBytes(8).toString('hex')}`
    const entry: ManagedProcessEntry = { child, output: [], base: 0, size: 0, exitCode: null, running: true }
    const append = (chunk: Buffer): void => {
      entry.output.push(chunk)
      entry.size += chunk.length
      while (entry.size > OUTPUT_LIMIT_BYTES && entry.output.length > 1) {
        const removed = entry.output.shift()
        if (removed) {
          entry.size -= removed.length
          entry.base += removed.length
        }
      }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.stdin?.on('error', () => undefined)
    child.on('error', () => {
      entry.running = false
    })
    child.on('close', (code) => {
      entry.running = false
      entry.exitCode = code
    })
    this.processes.set(id, entry)
    return { processId: id }
  }

  stdin(params: Params): unknown {
    const entry = this.entry(params.processId)
    const data = params.data
    if (data !== undefined && typeof data !== 'string') throw new WorkerRpcError('invalid_params', 'data deve ser texto')
    if (!entry.running || !entry.child.stdin || entry.child.stdin.destroyed) {
      throw new WorkerRpcError('conflict', 'O processo não aceita mais entrada')
    }
    if (data) entry.child.stdin.write(data)
    if (params.close === true) entry.child.stdin.end()
    return { written: data ? Buffer.byteLength(data) : 0 }
  }

  output(params: Params): unknown {
    const entry = this.entry(params.processId)
    const rawCursor = params.cursor
    if (rawCursor !== undefined && (typeof rawCursor !== 'number' || !Number.isSafeInteger(rawCursor) || rawCursor < 0)) {
      throw new WorkerRpcError('invalid_params', 'cursor inválido')
    }
    const cursor = Math.max(rawCursor ?? 0, entry.base)
    const all = Buffer.concat(entry.output, entry.size)
    const chunk = all.subarray(Math.min(cursor - entry.base, all.length))
    return {
      output: chunk.toString('utf8'),
      cursor: entry.base + all.length,
      running: entry.running,
      exitCode: entry.exitCode,
    }
  }

  kill(params: Params): unknown {
    const entry = this.entry(params.processId)
    const signal = params.signal ?? 'SIGTERM'
    if (signal !== 'SIGTERM' && signal !== 'SIGKILL' && signal !== 'SIGINT') {
      throw new WorkerRpcError('invalid_params', 'signal deve ser SIGTERM, SIGKILL ou SIGINT')
    }
    if (!entry.running) return { killed: false }
    killGroup(entry.child, signal)
    return { killed: true }
  }

  killAll(): void {
    for (const entry of this.processes.values()) if (entry.running) killGroup(entry.child, 'SIGKILL')
  }

  private entry(processId: unknown): ManagedProcessEntry {
    const entry = typeof processId === 'string' ? this.processes.get(processId) : undefined
    if (!entry) throw new WorkerRpcError('process_not_found', 'Processo não encontrado')
    return entry
  }
}
