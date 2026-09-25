import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WorkerRpcError } from '../worker-protocol/protocol.js'
import { resolveEntry, resolveInside, toRelative } from './jail.js'

export const READ_LIMIT_BYTES = 1024 * 1024
export const WRITE_LIMIT_BYTES = 4 * 1024 * 1024
const LIST_LIMIT = 1000
const SCAN_LIMIT = 50_000
const SEARCH_FILE_LIMIT = 1024 * 1024
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules'])

type Params = Record<string, unknown>

function optionalBoolean(params: Params, key: string): boolean {
  const value = params[key]
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new WorkerRpcError('invalid_params', `${key} deve ser boolean`)
  return value
}

function requiredString(params: Params, key: string, max = WRITE_LIMIT_BYTES): string {
  const value = params[key]
  if (typeof value !== 'string') throw new WorkerRpcError('invalid_params', `${key} é obrigatório`)
  if (Buffer.byteLength(value) > max) throw new WorkerRpcError('too_large', `${key} excede o limite`)
  return value
}

function boundedInteger(params: Params, key: string, fallback: number, min: number, max: number): number {
  const value = params[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new WorkerRpcError('invalid_params', `${key} deve ser inteiro entre ${min} e ${max}`)
  }
  return value
}

/**
 * Metadados do Git (`.git/config`, hooks, `info/attributes`) permitiriam ao agente
 * programar execução de código em um `git status` posterior. Alterações ali são recusadas.
 */
function assertNotGitMetadata(root: string, target: string): void {
  if (toRelative(root, target).split('/').includes('.git')) {
    throw new WorkerRpcError('permission_denied', 'Metadados do Git não podem ser alterados pelo agente')
  }
}

function ioError(error: unknown): WorkerRpcError {
  if (error instanceof WorkerRpcError) return error
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT') return new WorkerRpcError('not_found', 'Arquivo ou diretório não encontrado')
  if (code === 'EEXIST') return new WorkerRpcError('already_exists', 'O destino já existe')
  if (code === 'ENOTEMPTY') return new WorkerRpcError('conflict', 'O diretório não está vazio')
  if (code === 'ELOOP') return new WorkerRpcError('path_outside_workspace', 'Symlink recusado')
  return new WorkerRpcError('io_error', 'Falha de E/S no worker')
}

async function guard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw ioError(error)
  }
}

async function readBounded(path: string, limit: number): Promise<{ content: Buffer; totalBytes: number }> {
  // O_NONBLOCK evita que um FIFO dentro do workspace trave o worker na abertura.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new WorkerRpcError('invalid_params', 'O alvo não é um arquivo')
    const length = Math.min(info.size, limit)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return { content: buffer.subarray(0, bytesRead), totalBytes: info.size }
  } finally {
    await handle.close()
  }
}

async function writeNoFollow(path: string, content: string): Promise<number> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o644,
  )
  try {
    const data = Buffer.from(content, 'utf8')
    await handle.writeFile(data)
    return data.length
  } finally {
    await handle.close()
  }
}

/** Glob simples sobre o nome do arquivo: `*` e `?`; todo o resto é literal. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]*').replace(/\?/gu, '[^/]')
  return new RegExp(`^${escaped}$`, 'u')
}

async function* walk(root: string, start: string): AsyncGenerator<{ path: string; isFile: boolean }> {
  const queue = [start]
  let visited = 0
  while (queue.length > 0) {
    const directory = queue.shift()
    if (directory === undefined) break
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visited += 1
      if (visited > SCAN_LIMIT) return
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) queue.push(full)
        yield { path: full, isFile: false }
      } else if (entry.isFile()) {
        yield { path: full, isFile: true }
      }
    }
  }
}

export async function listDirectory(root: string, params: Params): Promise<unknown> {
  const target = resolveInside(root, params.path)
  return guard(async () => {
    const entries = await readdir(target, { withFileTypes: true })
    const result = []
    for (const entry of entries.slice(0, LIST_LIMIT)) {
      let size = 0
      if (entry.isFile()) size = (await lstat(join(target, entry.name)).catch(() => ({ size: 0 }))).size
      result.push({
        name: entry.name,
        type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'other',
        size,
      })
    }
    return { entries: result, truncated: entries.length > LIST_LIMIT }
  })
}

export async function findFile(root: string, params: Params): Promise<unknown> {
  const pattern = requiredString(params, 'pattern', 256)
  const maxResults = boundedInteger(params, 'maxResults', 200, 1, 500)
  const start = resolveInside(root, params.path)
  const matcher = globToRegExp(pattern)
  const paths: string[] = []
  for await (const entry of walk(root, start)) {
    const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
    if (!matcher.test(name)) continue
    if (paths.length >= maxResults) return { paths, truncated: true }
    paths.push(toRelative(root, entry.path))
  }
  return { paths, truncated: false }
}

export async function search(root: string, params: Params): Promise<unknown> {
  const query = requiredString(params, 'query', 1024)
  if (query.length === 0) throw new WorkerRpcError('invalid_params', 'query não pode ser vazia')
  const maxResults = boundedInteger(params, 'maxResults', 200, 1, 500)
  const caseSensitive = optionalBoolean(params, 'caseSensitive')
  const needle = caseSensitive ? query : query.toLowerCase()
  const start = resolveInside(root, params.path)
  const matches: { path: string; line: number; text: string }[] = []
  for await (const entry of walk(root, start)) {
    if (!entry.isFile) continue
    let content: Buffer
    try {
      const info = await stat(entry.path)
      if (info.size > SEARCH_FILE_LIMIT) continue
      content = (await readBounded(entry.path, SEARCH_FILE_LIMIT)).content
    } catch {
      continue
    }
    if (content.subarray(0, 8000).includes(0)) continue
    const lines = content.toString('utf8').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      if (!(caseSensitive ? line : line.toLowerCase()).includes(needle)) continue
      if (matches.length >= maxResults) return { matches, truncated: true }
      matches.push({ path: toRelative(root, entry.path), line: index + 1, text: line.slice(0, 300) })
    }
  }
  return { matches, truncated: false }
}

export async function readFile(root: string, params: Params): Promise<unknown> {
  const target = resolveInside(root, requiredString(params, 'path', 4096))
  const offset = boundedInteger(params, 'offset', 1, 1, Number.MAX_SAFE_INTEGER)
  const limit = params.limit === undefined ? undefined : boundedInteger(params, 'limit', 1, 1, 1_000_000)
  return guard(async () => {
    const { content, totalBytes } = await readBounded(target, READ_LIMIT_BYTES)
    let text = content.toString('utf8')
    if (offset > 1 || limit !== undefined) {
      const lines = text.split('\n')
      text = lines.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit).join('\n')
    }
    return { content: text, totalBytes, truncated: totalBytes > READ_LIMIT_BYTES }
  })
}

export async function writeFile(root: string, params: Params): Promise<unknown> {
  const target = resolveInside(root, requiredString(params, 'path', 4096))
  assertNotGitMetadata(root, target)
  const content = requiredString(params, 'content')
  const createDirectories = optionalBoolean(params, 'createDirectories')
  return guard(async () => {
    if (createDirectories) {
      await mkdir(dirname(target), { recursive: true })
      resolveInside(root, toRelative(root, target))
    }
    return { bytesWritten: await writeNoFollow(target, content) }
  })
}

export async function editFile(root: string, params: Params): Promise<unknown> {
  const target = resolveInside(root, requiredString(params, 'path', 4096))
  assertNotGitMetadata(root, target)
  const oldText = requiredString(params, 'oldText')
  const newText = requiredString(params, 'newText')
  const replaceAll = optionalBoolean(params, 'replaceAll')
  if (oldText.length === 0) throw new WorkerRpcError('invalid_params', 'oldText não pode ser vazio')
  return guard(async () => {
    const { content, totalBytes } = await readBounded(target, WRITE_LIMIT_BYTES)
    if (totalBytes > WRITE_LIMIT_BYTES) throw new WorkerRpcError('too_large', 'Arquivo grande demais para edição')
    const text = content.toString('utf8')
    const occurrences = text.split(oldText).length - 1
    if (occurrences === 0) throw new WorkerRpcError('conflict', 'oldText não encontrado no arquivo')
    if (occurrences > 1 && !replaceAll) {
      throw new WorkerRpcError('conflict', 'oldText aparece mais de uma vez; use replaceAll')
    }
    const updated = replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, () => newText)
    if (Buffer.byteLength(updated) > WRITE_LIMIT_BYTES) throw new WorkerRpcError('too_large', 'Resultado excede o limite')
    await writeNoFollow(target, updated)
    return { replacements: replaceAll ? occurrences : 1 }
  })
}

export async function makeDirectory(root: string, params: Params): Promise<unknown> {
  const target = resolveInside(root, requiredString(params, 'path', 4096))
  assertNotGitMetadata(root, target)
  return guard(async () => {
    const existed = await stat(target).then(() => true, () => false)
    await mkdir(target, { recursive: true })
    return { created: !existed }
  })
}

export async function deletePath(root: string, params: Params): Promise<unknown> {
  const input = requiredString(params, 'path', 4096)
  if (input.includes('\0')) throw new WorkerRpcError('invalid_params', 'path contém byte nulo')
  if (resolveInside(root, input) === root) throw new WorkerRpcError('invalid_params', 'A raiz do workspace não pode ser removida')
  const target = resolveEntry(root, input)
  assertNotGitMetadata(root, target)
  const recursive = optionalBoolean(params, 'recursive')
  return guard(async () => {
    const info = await lstat(target)
    if (info.isDirectory() && !recursive) await rmdir(target)
    else await rm(target, { recursive, force: false })
    return { deleted: true }
  })
}
