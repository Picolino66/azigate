import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { WorkerRpcError } from '../worker-protocol/protocol.js'

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

function outside(): WorkerRpcError {
  return new WorkerRpcError('path_outside_workspace', 'O caminho sai do workspace')
}

/**
 * Resolve um caminho relativo dentro da raiz (já em `realpath`) do workspace. Recusa
 * absolutos, `~` e bytes nulos; resolve symlinks do ancestral existente mais próximo e
 * exige que o resultado continue dentro da raiz (ADR-023).
 */
export function resolveInside(root: string, input: unknown): string {
  if (input === undefined) return root
  if (typeof input !== 'string' || input.length > 4096) {
    throw new WorkerRpcError('invalid_params', 'path deve ser texto')
  }
  if (input.includes('\0')) throw new WorkerRpcError('invalid_params', 'path contém byte nulo')
  if (isAbsolute(input) || input.startsWith('~')) throw outside()
  const candidate = resolve(root, input === '' ? '.' : input)
  if (!within(root, candidate)) throw outside()

  let existing = candidate
  const missing: string[] = []
  let real: string | undefined
  while (real === undefined) {
    try {
      real = realpathSync(existing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || existing === root) throw outside()
      missing.unshift(basename(existing))
      existing = dirname(existing)
    }
  }
  const finalPath = missing.length > 0 ? join(real, ...missing) : real
  if (!within(root, finalPath)) throw outside()
  return finalPath
}

/**
 * Resolve a entrada em si (sem seguir symlink no último componente): o diretório pai passa
 * pela jail e o nome final é mantido. Usado em remoção, para apagar o link e nunca o alvo.
 */
export function resolveEntry(root: string, input: string): string {
  const parentInput = dirname(input)
  const name = basename(input)
  if (name === '' || name === '.' || name === '..') throw outside()
  const parent = resolveInside(root, parentInput === '.' ? undefined : parentInput)
  const entry = join(parent, name)
  if (!within(root, entry) || entry === root) throw outside()
  return entry
}

/** Caminho relativo à raiz, para respostas ao agente (nunca o path real da máquina B). */
export function toRelative(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath)
  return rel === '' ? '.' : rel.split(sep).join('/')
}
