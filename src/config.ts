import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production'
  port: number
  host: string
  deepseekBaseUrl: URL
  deepseekApiKey: string
  gatewayApiKeys: readonly string[]
  allowedModels: ReadonlySet<string>
  defaultModel?: string
  allowedIps: ReadonlySet<string>
  requestTimeoutMs: number
  connectTimeoutMs: number
  maxRequestBodyBytes: number
  rateLimitMax: number
  rateLimitIpMax: number
  rateLimitWindowMs: number
  modelsCacheTtlMs: number
  logLevel: string
  trustProxy: boolean
  readyCheckUpstream: boolean
  upstreamMaxRetries: number
  retryMaxDelayMs: number
  enableCodexCli: boolean
  enableClaudeCli: boolean
  codexBaseUrl: URL
  codexTokenFile: string
  claudeBaseUrl: URL
  claudeTokenFile: string
}

function readValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`]
  if (file?.trim()) {
    try {
      return readFileSync(file, 'utf8').replace(/[\r\n]+$/u, '')
    } catch {
      throw new Error(`Não foi possível ler o arquivo configurado em ${name}_FILE`)
    }
  }
  return env[name]
}

function requiredSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = readValue(env, name)?.trim()
  if (!value) throw new Error(`Variável obrigatória ausente: ${name} ou ${name}_FILE`)
  return value
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]
  const value = raw === undefined || raw === '' ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} deve ser um inteiro entre ${min} e ${max}`)
  }
  return value
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} deve ser true ou false`)
}

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeBaseUrl(name: string, raw: string, nodeEnv: AppConfig['nodeEnv']): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${name} deve ser uma URL válida`)
  }
  const localDevelopment = nodeEnv !== 'production' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(localDevelopment && url.protocol === 'http:')) {
    throw new Error(`${name} deve usar HTTPS`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} não pode conter credenciais, query string ou fragmento`)
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`
  return url
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawNodeEnv = env.NODE_ENV ?? 'development'
  if (!['development', 'test', 'production'].includes(rawNodeEnv)) {
    throw new Error('NODE_ENV deve ser development, test ou production')
  }
  const nodeEnv = rawNodeEnv as AppConfig['nodeEnv']
  const gatewayApiKeys = [...new Set(csv(requiredSecret(env, 'GATEWAY_API_KEYS')))]
  if (gatewayApiKeys.length === 0) throw new Error('GATEWAY_API_KEYS precisa conter ao menos uma chave')

  const allowedModels = new Set(csv(env.ALLOWED_MODELS))
  const defaultModel = env.DEFAULT_MODEL?.trim() || undefined
  if (defaultModel && allowedModels.size > 0 && !allowedModels.has(defaultModel)) {
    throw new Error('DEFAULT_MODEL deve pertencer a ALLOWED_MODELS quando a allowlist estiver definida')
  }

  const allowedIpsList = csv(env.ALLOWED_IPS)
  for (const ip of allowedIpsList) {
    if (isIP(ip) === 0) throw new Error(`ALLOWED_IPS contém um IP inválido: ${ip}`)
  }

  const connectTimeoutMs = integer(env, 'CONNECT_TIMEOUT_MS', 30_000, 100, 600_000)
  const requestTimeoutMs = integer(env, 'REQUEST_TIMEOUT_MS', 600_000, 100, 3_600_000)
  if (connectTimeoutMs > requestTimeoutMs) {
    throw new Error('CONNECT_TIMEOUT_MS não pode exceder REQUEST_TIMEOUT_MS')
  }

  return {
    nodeEnv,
    port: integer(env, 'PORT', 3000, 1, 65_535),
    host: env.HOST?.trim() || '0.0.0.0',
    deepseekBaseUrl: normalizeBaseUrl('DEEPSEEK_BASE_URL', env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com', nodeEnv),
    deepseekApiKey: requiredSecret(env, 'DEEPSEEK_API_KEY'),
    gatewayApiKeys,
    allowedModels,
    ...(defaultModel ? { defaultModel } : {}),
    allowedIps: new Set(allowedIpsList),
    requestTimeoutMs,
    connectTimeoutMs,
    maxRequestBodyBytes: integer(env, 'MAX_REQUEST_BODY_BYTES', 10_485_760, 1024, 100 * 1024 * 1024),
    rateLimitMax: integer(env, 'RATE_LIMIT_MAX', 60, 1, 1_000_000),
    rateLimitIpMax: integer(env, 'RATE_LIMIT_IP_MAX', 60, 1, 1_000_000),
    rateLimitWindowMs: integer(env, 'RATE_LIMIT_WINDOW_MS', 60_000, 1000, 3_600_000),
    modelsCacheTtlMs: integer(env, 'MODELS_CACHE_TTL_SECONDS', 300, 60, 600) * 1000,
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    trustProxy: boolean(env, 'TRUST_PROXY', true),
    readyCheckUpstream: boolean(env, 'READY_CHECK_UPSTREAM', false),
    upstreamMaxRetries: integer(env, 'UPSTREAM_MAX_RETRIES', 0, 0, 2),
    retryMaxDelayMs: integer(env, 'RETRY_MAX_DELAY_MS', 2000, 0, 30_000),
    enableCodexCli: boolean(env, 'ENABLE_CODEX_CLI', false),
    enableClaudeCli: boolean(env, 'ENABLE_CLAUDE_CLI', false),
    codexBaseUrl: normalizeBaseUrl(
      'CODEX_BASE_URL',
      env.CODEX_BASE_URL?.trim() || 'https://chatgpt.com/backend-api/codex',
      nodeEnv,
    ),
    codexTokenFile: env.CODEX_TOKEN_FILE?.trim() || 'secrets/codex-oauth.json',
    claudeBaseUrl: normalizeBaseUrl('CLAUDE_BASE_URL', env.CLAUDE_BASE_URL?.trim() || 'https://api.anthropic.com', nodeEnv),
    claudeTokenFile: env.CLAUDE_TOKEN_FILE?.trim() || 'secrets/claude-oauth.json',
  }
}

export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    host: '127.0.0.1',
    deepseekBaseUrl: new URL('http://127.0.0.1:9999/'),
    deepseekApiKey: 'deepseek-test-secret',
    gatewayApiKeys: ['gateway-test-secret'],
    allowedModels: new Set(),
    allowedIps: new Set(),
    requestTimeoutMs: 1000,
    connectTimeoutMs: 500,
    maxRequestBodyBytes: 10_485_760,
    rateLimitMax: 60,
    rateLimitIpMax: 60,
    rateLimitWindowMs: 60_000,
    modelsCacheTtlMs: 300_000,
    logLevel: 'silent',
    trustProxy: false,
    readyCheckUpstream: false,
    upstreamMaxRetries: 0,
    retryMaxDelayMs: 10,
    enableCodexCli: false,
    enableClaudeCli: false,
    codexBaseUrl: new URL('http://127.0.0.1:9999/'),
    codexTokenFile: '/tmp/azigate-test-codex-oauth.json',
    claudeBaseUrl: new URL('http://127.0.0.1:9999/'),
    claudeTokenFile: '/tmp/azigate-test-claude-oauth.json',
    ...overrides,
  }
}
