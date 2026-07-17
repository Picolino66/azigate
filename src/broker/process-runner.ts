import { spawn } from 'node:child_process'

export interface ProcessRunSpec {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs: number
  killGraceMs: number
  maxOutputBytes: number
  signal?: AbortSignal
}

export interface ProcessRunResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  outputExceeded: boolean
}

export interface ProcessRunnerLike {
  run(spec: ProcessRunSpec): Promise<ProcessRunResult>
}

function killProcessGroup(pid: number | undefined, fallback: () => boolean, signal: NodeJS.Signals): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    fallback()
  }
}

export class ProcessRunner implements ProcessRunnerLike {
  run(spec: ProcessRunSpec): Promise<ProcessRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        detached: true,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let timedOut = false
      let aborted = false
      let outputExceeded = false
      let terminating = false
      let forceTimer: NodeJS.Timeout | undefined

      const terminate = (): void => {
        if (terminating) return
        terminating = true
        killProcessGroup(child.pid, () => child.kill('SIGTERM'), 'SIGTERM')
        forceTimer = setTimeout(() => {
          killProcessGroup(child.pid, () => child.kill('SIGKILL'), 'SIGKILL')
        }, spec.killGraceMs)
        forceTimer.unref()
      }
      const collect = (target: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.length
        if (outputBytes > spec.maxOutputBytes) {
          outputExceeded = true
          terminate()
          return
        }
        target.push(chunk)
      }
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))

      const timeout = setTimeout(() => {
        timedOut = true
        terminate()
      }, spec.timeoutMs)
      timeout.unref()
      const onAbort = (): void => {
        aborted = true
        terminate()
      }
      spec.signal?.addEventListener('abort', onAbort, { once: true })
      if (spec.signal?.aborted) onAbort()

      child.once('error', (error) => {
        clearTimeout(timeout)
        if (forceTimer) clearTimeout(forceTimer)
        spec.signal?.removeEventListener('abort', onAbort)
        reject(error)
      })
      child.once('close', (exitCode, signal) => {
        clearTimeout(timeout)
        if (forceTimer) clearTimeout(forceTimer)
        spec.signal?.removeEventListener('abort', onAbort)
        resolve({
          exitCode,
          signal,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
          aborted,
          outputExceeded,
        })
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(spec.stdin ?? '')
    })
  }
}
