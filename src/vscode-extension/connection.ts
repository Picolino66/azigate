import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { parseWorkspaces } from '../agent-control/workspaces.js'
import { resolveAgentUrl, resolveClientSettings } from '../agent-client/settings.js'
import { azigateConfigDir } from '../workspace/security/local-files.js'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export interface ConnectionInput {
  /** `azigate.agentUrl` das configurações de usuário (escopo `machine`); vazio usa o padrão do CLI. */
  urlOverride?: string | undefined
  /** Chave guardada no SecretStorage do VS Code. */
  secretKey?: string | undefined
  env?: NodeJS.ProcessEnv
}

export interface Connection {
  url: string
  key: string
}

/**
 * A chave do agentd segue no header `Authorization`, então a URL precisa ser `https://`;
 * `http://` só é aceito em loopback (túnel SSH), como o `wss://` do Workspace Server.
 */
export function validateAgentUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('A URL do agentd é inválida')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error('A URL do agentd deve usar https:// (http:// só em loopback)')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('A URL do agentd não pode conter credenciais, query string ou fragmento')
  }
  return url.toString().replace(/\/+$/u, '')
}

/**
 * URL: configuração do usuário → `AZIGATE_AGENT_URL` → `agent.json` → padrão do túnel.
 * Chave: SecretStorage → `AZIGATE_AGENT_KEY_FILE` → `AZIGATE_AGENT_KEY` → `agent.key` (0600).
 */
export function resolveConnection(input: ConnectionInput): Connection {
  const env = input.env ?? process.env
  const override = input.urlOverride?.trim()
  const secret = input.secretKey?.trim()
  const url = validateAgentUrl(override || resolveAgentUrl(env))
  // Com a chave no SecretStorage, o arquivo agent.key nem é lido.
  const key = secret || resolveClientSettings(env).key
  if (!key) {
    throw new Error('Chave do agentd ausente: use o comando "Azigate: Definir chave do agentd" ou crie agent.key (0600)')
  }
  return { url, key }
}

export interface LocalWorkspaces {
  /** ID → raiz real, lido do `workspace.json` gerado pelo `client:setup`. */
  workspaces: Map<string, string>
  configPath: string
  exists: boolean
}

/** Lê os workspaces locais da máquina B; ausência do arquivo não é erro. */
export function loadLocalWorkspaces(env: NodeJS.ProcessEnv = process.env): LocalWorkspaces {
  const configPath = join(azigateConfigDir(env), 'workspace.json')
  if (!existsSync(configPath)) return { workspaces: new Map(), configPath, exists: false }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
  } catch {
    throw new Error(`${configPath}: JSON inválido ou inacessível`)
  }
  return { workspaces: parseWorkspaces(raw, configPath), configPath, exists: true }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Escolhe o workspace que contém a pasta aberta no VS Code. Só compara caminhos locais para
 * pré-selecionar um ID; o caminho nunca sai da máquina B.
 */
export function workspaceForFolders(workspaces: ReadonlyMap<string, string>, folders: readonly string[]): string | undefined {
  for (const folder of folders) {
    let real: string
    try {
      real = realpathSync(folder)
    } catch {
      continue
    }
    let best: { id: string; depth: number } | undefined
    for (const [id, root] of workspaces) {
      if (inside(root, real) && (!best || root.length > best.depth)) best = { id, depth: root.length }
    }
    if (best) return best.id
  }
  return undefined
}
