import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export interface BrokerConfig {
  socketPath: string
  workRoot: string
  enableCodex: boolean
  enableClaude: boolean
  executionTimeoutMs: number
  killGraceMs: number
  maxOutputBytes: number
  maxRequestBytes: number
  bwrapPath: string
  codexPath: string
  claudePath: string
  codexAuthDir: string
  claudeAuthDir: string
  claudeConfigPath: string
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

function absolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} deve ser um path absoluto`)
  return value
}

export function loadBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const home = env.HOME?.trim() || homedir()
  return {
    socketPath: absolutePath(env.BROKER_SOCKET_PATH?.trim() || '/run/gateway-ai/broker.sock', 'BROKER_SOCKET_PATH'),
    workRoot: absolutePath(
      env.BROKER_WORK_ROOT?.trim() || join(tmpdir(), 'gateway-ai-broker'),
      'BROKER_WORK_ROOT',
    ),
    enableCodex: boolean(env, 'BROKER_ENABLE_CODEX_CLI', true),
    enableClaude: boolean(env, 'BROKER_ENABLE_CLAUDE_CLI', false),
    executionTimeoutMs: integer(env, 'BROKER_EXECUTION_TIMEOUT_MS', 600_000, 1000, 3_600_000),
    killGraceMs: integer(env, 'BROKER_KILL_GRACE_MS', 2000, 100, 30_000),
    maxOutputBytes: integer(env, 'BROKER_MAX_OUTPUT_BYTES', 4_194_304, 65_536, 16_777_216),
    maxRequestBytes: integer(env, 'BROKER_MAX_REQUEST_BYTES', 10_485_760, 1024, 100 * 1024 * 1024),
    bwrapPath: env.BWRAP_PATH?.trim() || '/usr/bin/bwrap',
    codexPath: env.CODEX_CLI_PATH?.trim() || '/usr/bin/codex',
    claudePath: env.CLAUDE_CLI_PATH?.trim() || join(home, '.local/bin/claude'),
    codexAuthDir: absolutePath(env.CODEX_AUTH_DIR?.trim() || join(home, '.codex'), 'CODEX_AUTH_DIR'),
    claudeAuthDir: absolutePath(env.CLAUDE_AUTH_DIR?.trim() || join(home, '.claude'), 'CLAUDE_AUTH_DIR'),
    claudeConfigPath: absolutePath(
      env.CLAUDE_CONFIG_PATH?.trim() || join(home, '.claude.json'),
      'CLAUDE_CONFIG_PATH',
    ),
  }
}
