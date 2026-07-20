import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { ClientAbortedError } from '../upstream/errors.js'
import { CliExecutionFailedError, CliTimeoutError } from '../providers/errors.js'

export interface InteractiveProcessSpec {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  killGraceMs: number
  maxOutputBytes: number
}

export interface InteractiveProcessLike {
  resetOutputBudget(): void
  writeJson(value: unknown): void
  readJson(timeoutMs: number, signal?: AbortSignal): Promise<unknown>
  terminate(): Promise<void>
}

export interface InteractiveProcessFactoryLike {
  spawn(spec: InteractiveProcessSpec): InteractiveProcessLike
}

interface PendingReader {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timeout: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
}

function killProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

export class InteractiveProcess implements InteractiveProcessLike {
  private readonly lines: unknown[] = []
  private readonly readers: PendingReader[] = []
  private buffer = ''
  private outputBytes = 0
  private closed = false
  private terminating = false
  private forceTimer: NodeJS.Timeout | undefined
  private readonly closePromise: Promise<void>

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly spec: InteractiveProcessSpec,
  ) {
    this.closePromise = new Promise((resolve) => {
      child.once('close', () => {
        this.closed = true
        if (this.forceTimer) clearTimeout(this.forceTimer)
        this.rejectReaders(new CliExecutionFailedError())
        resolve()
      })
    })
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk))
    child.stderr.on('data', (chunk: Buffer) => this.countOutput(chunk.length))
    child.stdin.on('error', () => undefined)
    child.once('error', () => {
      this.closed = true
      this.rejectReaders(new CliExecutionFailedError())
    })
  }

  writeJson(value: unknown): void {
    if (this.closed || this.terminating || !this.child.stdin.writable) throw new CliExecutionFailedError()
    const line = `${JSON.stringify(value)}\n`
    this.child.stdin.write(line)
  }

  resetOutputBudget(): void {
    this.outputBytes = 0
  }

  readJson(timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const queued = this.lines.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.closed || this.terminating) return Promise.reject(new CliExecutionFailedError())
    if (signal?.aborted) return Promise.reject(new ClientAbortedError())
    return new Promise((resolve, reject) => {
      const reader: PendingReader = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.removeReader(reader)
          reject(new CliTimeoutError())
        }, timeoutMs),
        ...(signal === undefined ? {} : { signal }),
      }
      reader.timeout.unref()
      if (signal !== undefined) {
        reader.onAbort = (): void => {
          this.removeReader(reader)
          reject(new ClientAbortedError())
        }
        signal.addEventListener('abort', reader.onAbort, { once: true })
      }
      this.readers.push(reader)
    })
  }

  async terminate(): Promise<void> {
    if (this.closed) return
    if (!this.terminating) {
      this.terminating = true
      this.rejectReaders(new CliExecutionFailedError())
      killProcessGroup(this.child, 'SIGTERM')
      this.forceTimer = setTimeout(() => killProcessGroup(this.child, 'SIGKILL'), this.spec.killGraceMs)
      this.forceTimer.unref()
    }
    await this.closePromise
  }

  private consume(chunk: Buffer): void {
    if (!this.countOutput(chunk.length)) return
    this.buffer += chunk.toString('utf8')
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        void this.terminate()
        this.rejectReaders(new CliExecutionFailedError())
        return
      }
      const reader = this.readers.shift()
      if (reader === undefined) this.lines.push(parsed)
      else {
        this.clearReader(reader)
        reader.resolve(parsed)
      }
    }
  }

  private countOutput(bytes: number): boolean {
    this.outputBytes += bytes
    if (this.outputBytes <= this.spec.maxOutputBytes) return true
    void this.terminate()
    this.rejectReaders(new CliExecutionFailedError())
    return false
  }

  private removeReader(reader: PendingReader): void {
    const index = this.readers.indexOf(reader)
    if (index >= 0) this.readers.splice(index, 1)
    this.clearReader(reader)
  }

  private clearReader(reader: PendingReader): void {
    clearTimeout(reader.timeout)
    if (reader.signal !== undefined && reader.onAbort !== undefined) {
      reader.signal.removeEventListener('abort', reader.onAbort)
    }
  }

  private rejectReaders(error: unknown): void {
    for (const reader of this.readers.splice(0)) {
      this.clearReader(reader)
      reader.reject(error)
    }
  }
}

export class InteractiveProcessFactory implements InteractiveProcessFactoryLike {
  spawn(spec: InteractiveProcessSpec): InteractiveProcessLike {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return new InteractiveProcess(child, spec)
  }
}
