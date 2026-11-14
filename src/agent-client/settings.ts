import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { azigateConfigDir, readPrivateFile } from '../workspace/security/local-files.js'

export const DEFAULT_AGENT_URL = 'http://127.0.0.1:3100'

export interface ClientSettings {
  url: string
  key: string | undefined
}

/**
 * Onde o cliente encontra o agentd e a chave, em ordem:
 * `AZIGATE_AGENT_URL` → `agent.json` da pasta local → padrão do túnel SSH;
 * `AZIGATE_AGENT_KEY_FILE` → `AZIGATE_AGENT_KEY` → `agent.key` (0600) da pasta local.
 */
export function resolveClientSettings(env: NodeJS.ProcessEnv = process.env): ClientSettings {
  return { url: resolveAgentUrl(env), key: resolveKey(env, azigateConfigDir(env)) }
}

/** Só a URL do agentd, sem tocar no arquivo de chave. */
export function resolveAgentUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.AZIGATE_AGENT_URL?.trim() || fileUrl(join(azigateConfigDir(env), 'agent.json')) || DEFAULT_AGENT_URL
}

function fileUrl(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${path}: JSON inválido`)
  }
  const url = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).url : undefined
  if (typeof url !== 'string' || !url.trim()) throw new Error(`${path}: campo "url" ausente`)
  return url.trim()
}

function resolveKey(env: NodeJS.ProcessEnv, dir: string): string | undefined {
  const file = env.AZIGATE_AGENT_KEY_FILE?.trim()
  if (file) return readPrivateFile(file, 'da chave')
  const key = env.AZIGATE_AGENT_KEY?.trim()
  if (key) return key
  const local = join(dir, 'agent.key')
  return existsSync(local) ? readPrivateFile(local, 'da chave') : undefined
}
