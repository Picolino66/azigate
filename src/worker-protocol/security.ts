import { createHmac, timingSafeEqual } from 'node:crypto'
import { WORKSPACE_ID_PATTERN } from '../agent-control/workspaces.js'

export const WORKER_ID_PATTERN = WORKSPACE_ID_PATTERN
export const MIN_WORKER_SECRET_LENGTH = 32

export interface WorkerIdentity {
  workerId: string
  workspaces: ReadonlySet<string>
  expiresAt: number
}

interface TokenPayload {
  v: 1
  sub: string
  scopes: string[]
  iat: number
  exp: number
}

function sign(secret: string, encodedPayload: string): Buffer {
  return createHmac('sha256', secret).update(encodedPayload, 'utf8').digest()
}

/** Gera um token `payload.assinatura` (HMAC-SHA256) com escopos por workspace (ADR-023). */
export function signWorkerToken(
  secret: string,
  options: { workerId: string; workspaces: readonly string[]; ttlSeconds: number; now?: number },
): string {
  if (secret.length < MIN_WORKER_SECRET_LENGTH) throw new Error('WORKER_TOKEN_SECRET precisa de ao menos 32 caracteres')
  if (!WORKER_ID_PATTERN.test(options.workerId)) throw new Error('Identificador de worker inválido')
  if (options.workspaces.length === 0) throw new Error('Informe ao menos um workspace')
  for (const workspace of options.workspaces) {
    if (!WORKSPACE_ID_PATTERN.test(workspace)) throw new Error(`Identificador de workspace inválido: ${workspace}`)
  }
  if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds <= 0) throw new Error('Validade inválida')
  const iat = Math.floor((options.now ?? Date.now()) / 1000)
  const payload: TokenPayload = {
    v: 1,
    sub: options.workerId,
    scopes: ['worker:connect', ...[...new Set(options.workspaces)].map((workspace) => `workspace:${workspace}`)],
    iat,
    exp: iat + options.ttlSeconds,
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${encoded}.${sign(secret, encoded).toString('base64url')}`
}

/** Valida assinatura (tempo constante), expiração e escopos. `undefined` para qualquer falha. */
export function verifyWorkerToken(secret: string, token: string, now = Date.now()): WorkerIdentity | undefined {
  const parts = token.split('.')
  if (parts.length !== 2) return undefined
  const [encoded, signature] = parts as [string, string]
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || !/^[A-Za-z0-9_-]+$/u.test(signature)) return undefined
  const expected = sign(secret, encoded)
  const provided = Buffer.from(signature, 'base64url')
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
  } catch {
    return undefined
  }
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Partial<TokenPayload>
  if (
    record.v !== 1 ||
    typeof record.sub !== 'string' ||
    !WORKER_ID_PATTERN.test(record.sub) ||
    !Array.isArray(record.scopes) ||
    typeof record.exp !== 'number' ||
    record.exp * 1000 <= now
  ) {
    return undefined
  }
  if (!record.scopes.includes('worker:connect')) return undefined
  const workspaces = new Set<string>()
  for (const scope of record.scopes) {
    if (typeof scope === 'string' && scope.startsWith('workspace:')) {
      const workspace = scope.slice('workspace:'.length)
      if (WORKSPACE_ID_PATTERN.test(workspace)) workspaces.add(workspace)
    }
  }
  return { workerId: record.sub, workspaces, expiresAt: record.exp * 1000 }
}

export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer[ \t]+(\S+)$/iu.exec(header ?? '')
  return match?.[1]
}
