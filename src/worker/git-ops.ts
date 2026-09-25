import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { WorkerRpcError } from '../worker-protocol/protocol.js'
import { resolveInside, toRelative } from './jail.js'
import { OUTPUT_LIMIT_BYTES, workspaceEnv } from './process-ops.js'

const GIT_TIMEOUT_MS = 30_000

/**
 * Opções que impedem a configuração do repositório de executar programas: fsmonitor,
 * diff externo e textconv ficam desligados (ADR-023).
 */
const HARDENING = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=']

type Params = Record<string, unknown>

function runGit(root: string, args: readonly string[]): Promise<{ output: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...HARDENING, ...args], {
      cwd: root,
      env: {
        ...workspaceEnv(),
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        // Impede o git de subir além da raiz e ler um repositório fora do workspace.
        GIT_CEILING_DIRECTORIES: dirname(root),
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let size = 0
    let truncated = false
    const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      if (size >= OUTPUT_LIMIT_BYTES) {
        truncated = true
        return
      }
      const piece = chunk.subarray(0, OUTPUT_LIMIT_BYTES - size)
      if (piece.length < chunk.length) truncated = true
      chunks.push(piece)
      size += piece.length
    })
    child.stderr.on('data', () => undefined)
    child.on('error', () => {
      clearTimeout(timer)
      reject(new WorkerRpcError('io_error', 'git não está disponível no worker'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new WorkerRpcError('io_error', 'O comando git falhou (o workspace é um repositório?)'))
        return
      }
      resolve({ output: Buffer.concat(chunks, size).toString('utf8'), truncated })
    })
  })
}

export async function gitStatus(root: string): Promise<unknown> {
  return runGit(root, ['status', '--porcelain=v1', '--branch'])
}

export async function gitDiff(root: string, params: Params): Promise<unknown> {
  const staged = params.staged ?? false
  if (typeof staged !== 'boolean') throw new WorkerRpcError('invalid_params', 'staged deve ser boolean')
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color']
  if (staged) args.push('--cached')
  if (params.path !== undefined) args.push('--', toRelative(root, resolveInside(root, params.path)))
  return runGit(root, args)
}

export async function gitLog(root: string, params: Params): Promise<unknown> {
  const maxCount = params.maxCount ?? 20
  if (typeof maxCount !== 'number' || !Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > 200) {
    throw new WorkerRpcError('invalid_params', 'maxCount deve ficar entre 1 e 200')
  }
  return runGit(root, ['log', `--max-count=${maxCount}`, '--date=iso-strict', '--format=%H%x09%an%x09%ad%x09%s', '--no-color'])
}
