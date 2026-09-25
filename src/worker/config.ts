import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { parseWorkspaces } from '../agent-control/workspaces.js'
import { WORKER_ID_PATTERN } from '../worker-protocol/security.js'
import type { ExecPolicy } from './process-ops.js'

export interface WorkerConfig {
  gatewayUrl: URL
  workerId: string
  tokenFile: string
  workspaces: Map<string, string>
  exec: ExecPolicy
}

interface CliOptions {
  config?: string
  gateway?: string
  worker?: string
  tokenFile?: string
}

export function parseWorkerArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {}
  const flags: Record<string, keyof CliOptions> = {
    '--config': 'config',
    '--gateway': 'gateway',
    '--worker': 'worker',
    '--token-file': 'tokenFile',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? ''
    if (flag === '--token') {
      throw new Error('Use --token-file: o token em argv fica visível para outros usuários em ps')
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
  const info = statSync(path)
  if ((info.mode & 0o077) !== 0) throw new Error('O arquivo do token precisa ter permissão 0600')
  const token = readFileSync(path, 'utf8').trim()
  if (!token) throw new Error('O arquivo do token está vazio')
  return token
}

export function loadWorkerConfig(argv: readonly string[], cwd = process.cwd()): WorkerConfig {
  const cli = parseWorkerArgs(argv)
  if (!cli.config) throw new Error('Informe --config <arquivo.json>')
  const configPath = resolve(cwd, cli.config)
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  } catch {
    throw new Error('Não foi possível ler o arquivo de configuração do worker (JSON inválido ou inacessível)')
  }
  const gateway = cli.gateway ?? (typeof raw.gateway === 'string' ? raw.gateway : undefined)
  const workerId = cli.worker ?? (typeof raw.workerId === 'string' ? raw.workerId : undefined)
  const tokenFileRaw = cli.tokenFile ?? (typeof raw.tokenFile === 'string' ? raw.tokenFile : undefined)
  if (!gateway) throw new Error('Configuração sem "gateway"')
  if (!workerId || !WORKER_ID_PATTERN.test(workerId)) throw new Error('Configuração com "workerId" ausente ou inválido')
  if (!tokenFileRaw) throw new Error('Configuração sem "tokenFile"')
  const tokenFile = isAbsolute(tokenFileRaw) ? tokenFileRaw : resolve(dirname(configPath), tokenFileRaw)

  const execRaw = typeof raw.exec === 'object' && raw.exec !== null ? (raw.exec as Record<string, unknown>) : {}
  const enabled = execRaw.enabled === true
  let allowedCommands: Set<string> | undefined
  if (execRaw.allowedCommands !== undefined) {
    if (!Array.isArray(execRaw.allowedCommands) || !execRaw.allowedCommands.every((item) => typeof item === 'string' && item.length > 0)) {
      throw new Error('"exec.allowedCommands" deve ser uma lista de nomes de programa')
    }
    allowedCommands = new Set(execRaw.allowedCommands as string[])
  }

  return {
    gatewayUrl: workerConnectUrl(gateway),
    workerId,
    tokenFile,
    workspaces: parseWorkspaces(raw, 'Configuração do worker'),
    exec: { enabled, ...(allowedCommands ? { allowedCommands } : {}) },
  }
}
