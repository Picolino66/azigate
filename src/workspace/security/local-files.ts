import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Pasta de configuração local da máquina do projeto (B): `AZIGATE_CONFIG_DIR`, senão
 * `$XDG_CONFIG_HOME/azigate`, senão `~/.config/azigate`. Usada pelo Workspace Server e pelo
 * `azigate-agent` para funcionarem sem flags depois do `client:setup`.
 */
export function azigateConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AZIGATE_CONFIG_DIR?.trim()
  if (explicit) return explicit
  const xdg = env.XDG_CONFIG_HOME?.trim()
  return join(xdg || join(env.HOME?.trim() || homedir(), '.config'), 'azigate')
}

/** Segredo em arquivo: não pode ser legível por grupo ou outros usuários (como uma chave SSH). */
export function readPrivateFile(path: string, label: string): string {
  const info = statSync(path)
  if ((info.mode & 0o077) !== 0) throw new Error(`O arquivo ${label} precisa ter permissão 0600`)
  const value = readFileSync(path, 'utf8').trim()
  if (!value) throw new Error(`O arquivo ${label} está vazio`)
  return value
}
