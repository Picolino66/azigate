import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { WORKER_METHODS } from '../../workspace/protocol/protocol.js'
import { minimalEnv } from '../core/process.js'
import { runInspectionCommand } from '../core/versions.js'

/** Nome do agente AGY usado nas sessões com workspace remoto. */
export const AGY_REMOTE_AGENT = 'azigate-workspace'
export const AGY_MCP_SERVER = 'azigate_workspace'

export interface AgyPaths {
  agentFile: string
  settingsFile: string
  mcpConfigFile: string
}

/** Caminhos da configuração do AGY 1.2.x verificados no host (ADR-025). */
export function agyPaths(home: string): AgyPaths {
  return {
    agentFile: join(home, '.gemini', 'config', 'agents', `${AGY_REMOTE_AGENT}.md`),
    settingsFile: join(home, '.gemini', 'antigravity-cli', 'settings.json'),
    mcpConfigFile: join(home, '.gemini', 'config', 'mcp_config.json'),
  }
}

export function agyPermissionRules(): string[] {
  return WORKER_METHODS.map((method) => `mcp(${AGY_MCP_SERVER}/${method})`)
}

/**
 * Agente sem os componentes embutidos (arquivos, terminal e navegador da máquina A) que herda
 * o servidor MCP `azigate_workspace`; a meta-ferramenta `call_mcp_tool` continua disponível.
 */
export function agyAgentDefinition(): string {
  return `---
name: ${AGY_REMOTE_AGENT}
description: Agente do Azigate (gerenciado pelo azigate-agentd) para projetos em workspace remoto via MCP
mainAgent: true
excludeDefaultComponents: true
---
# Azigate Workspace

O projeto desta conversa não está nesta máquina. Ele está em um workspace remoto, acessível
somente pelas ferramentas MCP do servidor \`${AGY_MCP_SERVER}\` (list_directory, find_file, search,
read_file, write_file, edit_file, mkdir, delete, git_status, git_diff, git_log, shell_exec e
process_*). Use \`call_mcp_tool\` com ServerName \`${AGY_MCP_SERVER}\`. Caminhos são relativos à raiz
do workspace e comandos usam argv, sem shell. Leia antes de alterar e confirme o resultado com
git_status/git_diff.
`
}

function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:"'])\/\/.*$/gmu, '$1').replace(/,\s*([}\]])/gu, '$1')
}

function readJsonTolerant(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/u, '')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return JSON.parse(stripJsonComments(text)) as Record<string, unknown>
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.azigate-${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode })
  renameSync(temporary, path)
  chmodSync(path, mode)
}

export interface AgyRemoteStatus {
  mcpRegistered: boolean
  agentInstalled: boolean
  permissionsGranted: boolean
  ready: boolean
}

export function agyRemoteStatus(home: string): AgyRemoteStatus {
  const paths = agyPaths(home)
  let mcpRegistered: boolean
  let permissionsGranted: boolean
  try {
    const servers = readJsonTolerant(paths.mcpConfigFile).mcpServers
    mcpRegistered = typeof servers === 'object' && servers !== null && AGY_MCP_SERVER in servers
  } catch {
    mcpRegistered = false
  }
  try {
    const permissions = readJsonTolerant(paths.settingsFile).permissions
    const allow = typeof permissions === 'object' && permissions !== null ? (permissions as { allow?: unknown }).allow : undefined
    permissionsGranted = Array.isArray(allow) && agyPermissionRules().every((rule) => allow.includes(rule))
  } catch {
    permissionsGranted = false
  }
  const agentInstalled = existsSync(paths.agentFile) && readFileSync(paths.agentFile, 'utf8') === agyAgentDefinition()
  return { mcpRegistered, agentInstalled, permissionsGranted, ready: mcpRegistered && agentInstalled && permissionsGranted }
}

export interface AgyRemoteSetupOptions {
  binary: string
  home: string
  bridge: { command: string; args: readonly string[] }
  env?: NodeJS.ProcessEnv
}

/**
 * Prepara o AGY para sessões remotas. Idempotente e restrito a entradas com o nome do Azigate:
 * servidor MCP `azigate_workspace` (via `agy mcp add`), agente `azigate-workspace` e regras
 * `mcp(azigate_workspace/<ferramenta>)`. Fora de uma sessão Azigate a ponte expõe zero
 * ferramentas, então essas regras não liberam nada.
 */
export async function installAgyRemote(options: AgyRemoteSetupOptions): Promise<AgyRemoteStatus> {
  const paths = agyPaths(options.home)
  const env = minimalEnv({ ...(options.env ?? process.env), HOME: options.home })
  const added = await runInspectionCommand(
    options.binary,
    ['mcp', 'add', AGY_MCP_SERVER, '--', options.bridge.command, ...options.bridge.args],
    { cwd: options.home, env },
  )
  if (!added.ok) throw new Error('agy mcp add falhou')

  mkdirSync(dirname(paths.agentFile), { recursive: true, mode: 0o700 })
  writeFileSync(paths.agentFile, agyAgentDefinition(), { mode: 0o600 })

  const settings = readJsonTolerant(paths.settingsFile)
  const permissions = typeof settings.permissions === 'object' && settings.permissions !== null
    ? (settings.permissions as Record<string, unknown>)
    : {}
  const allow = Array.isArray(permissions.allow) ? [...(permissions.allow as unknown[])] : []
  let changed = false
  for (const rule of agyPermissionRules()) {
    if (!allow.includes(rule)) {
      allow.push(rule)
      changed = true
    }
  }
  if (changed || !Array.isArray(permissions.allow)) {
    writeJsonAtomic(paths.settingsFile, { ...settings, permissions: { ...permissions, allow } })
  }
  return agyRemoteStatus(options.home)
}

export async function uninstallAgyRemote(options: Omit<AgyRemoteSetupOptions, 'bridge'>): Promise<AgyRemoteStatus> {
  const paths = agyPaths(options.home)
  const env = minimalEnv({ ...(options.env ?? process.env), HOME: options.home })
  await runInspectionCommand(options.binary, ['mcp', 'remove', AGY_MCP_SERVER], { cwd: options.home, env })
  rmSync(paths.agentFile, { force: true })
  if (existsSync(paths.settingsFile)) {
    const settings = readJsonTolerant(paths.settingsFile)
    const permissions = typeof settings.permissions === 'object' && settings.permissions !== null
      ? (settings.permissions as Record<string, unknown>)
      : undefined
    if (permissions && Array.isArray(permissions.allow)) {
      const rules = new Set(agyPermissionRules())
      const allow = (permissions.allow as unknown[]).filter((rule) => typeof rule !== 'string' || !rules.has(rule))
      writeJsonAtomic(paths.settingsFile, { ...settings, permissions: { ...permissions, allow } })
    }
  }
  return agyRemoteStatus(options.home)
}
