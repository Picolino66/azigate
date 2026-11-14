import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseWorkspaces } from '../../agent-control/workspaces.js'
import { azigateConfigDir, readPrivateFile } from '../security/local-files.js'
import { WORKER_ID_PATTERN } from '../security/token.js'
import type { ExecPolicy } from '../process/process-ops.js'

export interface WorkerConfig {
  mode: 'connect'
  gatewayUrl: URL
  workerId: string
  tokenFile: string
  workspaces: Map<string, string>
  exec: ExecPolicy
}

/** Modo MCP por stdio: um cliente MCP local da própria máquina (por exemplo, um agente em B). */
export interface StdioWorkspaceConfig {
  mode: 'mcp-stdio'
  workspace: string
  workspaces: Map<string, string>
  exec: ExecPolicy
}

interface CliOptions {
  config?: string
  gateway?: string
  worker?: string
  tokenFile?: string
  workspace?: string
  mcpStdio?: boolean
}

export function parseWorkerArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {}
  const flags: Record<string, 'config' | 'gateway' | 'worker' | 'tokenFile' | 'workspace'> = {
    '--config': 'config',
    '--gateway': 'gateway',
    '--worker': 'worker',
    '--token-file': 'tokenFile',
    '--workspace': 'workspace',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? ''
    if (flag === '--token') {
      throw new Error('Use --token-file: o token em argv fica visível para outros usuários em ps')
    }
    if (flag === '--mcp-stdio') {
      options.mcpStdio = true
      continue
    }
    const key = flags[flag]
    const value = argv[index + 1]
    if (!key || value === undefined) throw new Error(`Argumento inválido: ${flag}`)
    options[key] = value
    index += 1
  }
  return options
}

/** URL de conexão: `wss://` obrigatório, exceto `ws://` em loopback. */
export function workerConnectUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('gateway deve ser uma URL válida')
  }
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol === 'http:') url.protocol = 'ws:'
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    throw new Error('gateway deve usar wss:// (TLS); ws:// só é aceito em loopback')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('gateway não pode conter credenciais, query string ou fragmento')
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/worker/v1/connect`
  return url
}

/** O token não pode ser legível por grupo ou outros usuários (como uma chave SSH). */
export function readTokenFile(path: string): string {
  return readPrivateFile(path, 'do token')
}

/** Sem `--config`, usa `workspace.json` da pasta local gerada pelo `client:setup`. */
export function loadWorkerConfig(
  argv: readonly string[],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig | StdioWorkspaceConfig {
  const cli = parseWorkerArgs(argv)
  const configPath = cli.config ? resolve(cwd, cli.config) : join(azigateConfigDir(env), 'workspace.json')
  if (!cli.config && !existsSync(configPath)) {
    throw new Error(`Informe --config <arquivo.json> ou crie ${configPath} com o bloco do client:setup`)
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  } catch {
    throw new Error('Não foi possível ler o arquivo de configuração do workspace server (JSON inválido ou inacessível)')
  }
  const execRaw = typeof raw.exec === 'object' && raw.exec !== null ? (raw.exec as Record<string, unknown>) : {}
  const enabled = execRaw.enabled === true
  let allowedCommands: Set<string> | undefined
  if (execRaw.allowedCommands !== undefined) {
    if (!Array.isArray(execRaw.allowedCommands) || !execRaw.allowedCommands.every((item) => typeof item === 'string' && item.length > 0)) {
      throw new Error('"exec.allowedCommands" deve ser uma lista de nomes de programa')
    }
    allowedCommands = new Set(execRaw.allowedCommands as string[])
  }
  const exec: ExecPolicy = { enabled, ...(allowedCommands ? { allowedCommands } : {}) }
  const workspaces = parseWorkspaces(raw, 'Configuração do workspace server')

  if (cli.mcpStdio) {
    if (!cli.workspace || !workspaces.has(cli.workspace)) throw new Error('Informe --workspace com um workspace da configuração')
    return { mode: 'mcp-stdio', workspace: cli.workspace, workspaces, exec }
  }

  const gateway = cli.gateway ?? (typeof raw.gateway === 'string' ? raw.gateway : undefined)
  const workerId = cli.worker ?? (typeof raw.workerId === 'string' ? raw.workerId : undefined)
  const tokenFileRaw = cli.tokenFile ?? (typeof raw.tokenFile === 'string' ? raw.tokenFile : undefined)
  if (!gateway) throw new Error('Configuração sem "gateway"')
  if (!workerId || !WORKER_ID_PATTERN.test(workerId)) throw new Error('Configuração com "workerId" ausente ou inválido')
  if (!tokenFileRaw) throw new Error('Configuração sem "tokenFile"')
  const tokenFile = isAbsolute(tokenFileRaw) ? tokenFileRaw : resolve(dirname(configPath), tokenFileRaw)
  return { mode: 'connect', gatewayUrl: workerConnectUrl(gateway), workerId, tokenFile, workspaces, exec }
}
