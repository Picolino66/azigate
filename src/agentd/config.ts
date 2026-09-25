import { isIP } from 'node:net'
import { isAbsolute, join, resolve } from 'node:path'
import type { AgentProviderId } from '../agents/core/agent-provider.js'
import type { VersionPolicy } from '../agents/core/agent-registry.js'
import type { SessionLimits } from '../agent-control/sessions.js'
import { boolean, csv, integer, readValue, requiredSecret } from '../config.js'
import { MIN_WORKER_SECRET_LENGTH } from '../worker-protocol/security.js'

export interface AgentProviderConfig {
  enabled: boolean
  binary: string
}

export interface AgentdConfig {
  nodeEnv: 'development' | 'test' | 'production'
  host: string
  port: number
  apiKeys: readonly string[]
  allowedIps: ReadonlySet<string>
  trustProxy: boolean
  rateLimitMax: number
  rateLimitIpMax: number
  rateLimitWindowMs: number
  maxRequestBodyBytes: number
  logLevel: string
  dataDir: string
  databasePath: string
  mcpSocketPath: string
  workspacesFile?: string
  versionPolicy: VersionPolicy
  providers: Readonly<Record<AgentProviderId, AgentProviderConfig>>
  limits: SessionLimits
  worker: {
    enabled: boolean
    tokenSecret?: string
    heartbeatIntervalMs: number
  }
}

const MIN_AGENT_KEY_LENGTH = 16
const BINARY_PATTERN = /^[A-Za-z0-9._/-]+$/u

/** Aceita `500ms`, `30s`, `30m`, `1h` ou um inteiro em milissegundos. */
export function parseDuration(name: string, raw: string | undefined, fallbackMs: number, minMs: number, maxMs: number): number {
  if (raw === undefined || raw.trim() === '') return fallbackMs
  const match = /^(\d+)(ms|s|m|h)?$/u.exec(raw.trim())
  if (!match) throw new Error(`${name} deve ser uma duração como 500ms, 30s, 30m ou 1h`)
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(match[2] ?? 'ms') as 'ms' | 's' | 'm' | 'h']
  const value = Number(match[1]) * factor
  if (!Number.isSafeInteger(value) || value < minMs || value > maxMs) {
    throw new Error(`${name} deve ficar entre ${minMs} ms e ${maxMs} ms`)
  }
  return value
}

function binary(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]?.trim() || fallback
  if (!BINARY_PATTERN.test(value) || value.startsWith('-') || (value.includes('/') && !isAbsolute(value))) {
    throw new Error(`${name} deve ser um nome de comando ou um caminho absoluto`)
  }
  return value
}

function optionalSecretList(env: NodeJS.ProcessEnv, name: string): string[] {
  try {
    return csv(readValue(env, name))
  } catch {
    return []
  }
}

export function loadAgentdConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AgentdConfig {
  if (!boolean(env, 'AGENT_GATEWAY_ENABLED', false)) {
    throw new Error('O Agent Plane está desabilitado: defina AGENT_GATEWAY_ENABLED=true')
  }
  const rawNodeEnv = env.NODE_ENV ?? 'development'
  if (!['development', 'test', 'production'].includes(rawNodeEnv)) {
    throw new Error('NODE_ENV deve ser development, test ou production')
  }
  const nodeEnv = rawNodeEnv as AgentdConfig['nodeEnv']

  const apiKeys = [...new Set(csv(requiredSecret(env, 'AGENT_API_KEYS')))]
  if (apiKeys.length === 0) throw new Error('AGENT_API_KEYS precisa conter ao menos uma chave')
  if (apiKeys.some((key) => key.length < MIN_AGENT_KEY_LENGTH)) {
    throw new Error(`Cada chave de AGENT_API_KEYS precisa de ao menos ${MIN_AGENT_KEY_LENGTH} caracteres`)
  }
  const modelPlaneKeys = new Set(optionalSecretList(env, 'GATEWAY_API_KEYS'))
  if (apiKeys.some((key) => modelPlaneKeys.has(key))) {
    throw new Error('Agent Plane e Model Plane devem ter credenciais separadas: AGENT_API_KEYS repete GATEWAY_API_KEYS')
  }

  const allowedIps = csv(env.AGENT_ALLOWED_IPS)
  for (const ip of allowedIps) {
    if (isIP(ip) === 0) throw new Error(`AGENT_ALLOWED_IPS contém um IP inválido: ${ip}`)
  }

  const workerEnabled = boolean(env, 'WORKER_ENABLED', false)
  let tokenSecret: string | undefined
  if (workerEnabled) {
    tokenSecret = requiredSecret(env, 'WORKER_TOKEN_SECRET')
    if (tokenSecret.length < MIN_WORKER_SECRET_LENGTH) {
      throw new Error(`WORKER_TOKEN_SECRET precisa de ao menos ${MIN_WORKER_SECRET_LENGTH} caracteres`)
    }
    if (apiKeys.includes(tokenSecret) || modelPlaneKeys.has(tokenSecret)) {
      throw new Error('WORKER_TOKEN_SECRET não pode repetir uma chave do Agent Plane ou do Model Plane')
    }
  }

  const rawPolicy = env.AGENT_VERSION_POLICY?.trim() || (nodeEnv === 'production' ? 'fail-closed' : 'warn')
  if (rawPolicy !== 'warn' && rawPolicy !== 'fail-closed') {
    throw new Error('AGENT_VERSION_POLICY deve ser warn ou fail-closed')
  }

  const dataDir = resolve(cwd, env.AGENT_DATA_DIR?.trim() || 'data/agentd')
  const workspacesFile = env.AGENT_WORKSPACES_FILE?.trim()
  const turnTimeoutMs = parseDuration('AGENT_TURN_TIMEOUT', env.AGENT_TURN_TIMEOUT, 3_600_000, 10_000, 86_400_000)
  const maxSessions = integer(env, 'AGENT_MAX_SESSIONS', 10, 1, 1000)

  return {
    nodeEnv,
    host: env.AGENT_HOST?.trim() || '127.0.0.1',
    port: integer(env, 'AGENT_PORT', 3100, 1, 65_535),
    apiKeys,
    allowedIps: new Set(allowedIps),
    trustProxy: boolean(env, 'AGENT_TRUST_PROXY', false),
    rateLimitMax: integer(env, 'AGENT_RATE_LIMIT_MAX', 120, 1, 1_000_000),
    rateLimitIpMax: integer(env, 'AGENT_RATE_LIMIT_IP_MAX', 120, 1, 1_000_000),
    rateLimitWindowMs: integer(env, 'AGENT_RATE_LIMIT_WINDOW_MS', 60_000, 1000, 3_600_000),
    maxRequestBodyBytes: integer(env, 'AGENT_MAX_REQUEST_BODY_BYTES', 1_048_576, 1024, 16 * 1024 * 1024),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    dataDir,
    databasePath: join(dataDir, 'agentd.db'),
    mcpSocketPath: resolve(cwd, env.AGENT_MCP_SOCKET?.trim() || join(dataDir, 'mcp.sock')),
    ...(workspacesFile ? { workspacesFile: resolve(cwd, workspacesFile) } : {}),
    versionPolicy: rawPolicy,
    providers: {
      codex: { enabled: boolean(env, 'CODEX_AGENT_ENABLED', false), binary: binary(env, 'CODEX_BINARY', 'codex') },
      claude: { enabled: boolean(env, 'CLAUDE_AGENT_ENABLED', false), binary: binary(env, 'CLAUDE_BINARY', 'claude') },
      agy: { enabled: boolean(env, 'AGY_AGENT_ENABLED', false), binary: binary(env, 'AGY_BINARY', 'agy') },
    },
    limits: {
      maxSessions,
      maxSessionsPerProvider: integer(env, 'AGENT_MAX_SESSIONS_PER_PROVIDER', 4, 1, maxSessions),
      idleTimeoutMs: parseDuration('AGENT_SESSION_IDLE_TIMEOUT', env.AGENT_SESSION_IDLE_TIMEOUT, 1_800_000, 10_000, 86_400_000),
      turnTimeoutMs,
      approvalTimeoutMs: parseDuration('AGENT_APPROVAL_TIMEOUT', env.AGENT_APPROVAL_TIMEOUT, 600_000, 5_000, turnTimeoutMs),
      cancelGraceMs: 20_000,
      eventBufferSize: integer(env, 'AGENT_EVENT_BUFFER', 2000, 100, 100_000),
      eventBufferBytes: integer(env, 'AGENT_EVENT_BUFFER_BYTES', 16 * 1024 * 1024, 1024 * 1024, 256 * 1024 * 1024),
      maxInputChars: integer(env, 'AGENT_MAX_INPUT_CHARS', 100_000, 1, 1_000_000),
      closedRetentionMs: 60_000,
    },
    worker: {
      enabled: workerEnabled,
      ...(tokenSecret ? { tokenSecret } : {}),
      heartbeatIntervalMs: parseDuration('WORKER_HEARTBEAT_INTERVAL', env.WORKER_HEARTBEAT_INTERVAL, 15_000, 1000, 300_000),
    },
  }
}
