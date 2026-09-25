import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

export interface WorkspaceConfigEntry {
  path: string
}

/**
 * Lê `{"workspaces": {"<id>": {"path": "/abs"}}}`, valida IDs e paths absolutos e resolve
 * cada raiz com `realpath`. Retorna o mapa ID → raiz real. Usado pelo agentd (workspaces
 * locais do host A) e pelo worker (workspaces da máquina B).
 */
export function parseWorkspaces(raw: unknown, source: string): Map<string, string> {
  const workspaces = new Map<string, string>()
  const container = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).workspaces : undefined
  if (typeof container !== 'object' || container === null || Array.isArray(container)) {
    throw new Error(`${source} deve conter um objeto "workspaces"`)
  }
  for (const [id, entry] of Object.entries(container)) {
    if (!WORKSPACE_ID_PATTERN.test(id)) throw new Error(`${source}: identificador de workspace inválido: ${id}`)
    const path = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).path : undefined
    if (typeof path !== 'string' || !isAbsolute(path)) {
      throw new Error(`${source}: o workspace ${id} precisa de um "path" absoluto`)
    }
    let real: string
    try {
      real = realpathSync(path)
    } catch {
      throw new Error(`${source}: o diretório do workspace ${id} não existe`)
    }
    if (!statSync(real).isDirectory()) throw new Error(`${source}: o workspace ${id} não é um diretório`)
    if (real === '/') throw new Error(`${source}: o workspace ${id} não pode ser a raiz do sistema`)
    workspaces.set(id, real)
  }
  return workspaces
}

export function loadWorkspacesFile(path: string | undefined): Map<string, string> {
  if (!path) return new Map()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    throw new Error('Não foi possível ler o arquivo de workspaces (JSON inválido ou inacessível)')
  }
  return parseWorkspaces(raw, 'Arquivo de workspaces')
}
