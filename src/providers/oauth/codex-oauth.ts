import { fetch } from 'undici'
import type { PkceCodes } from './pkce.js'
import type { StoredOAuthToken } from './token-store.js'

export interface CodexOAuthEndpoints {
  authUrl: string
  tokenUrl: string
  clientId: string
  redirectUri: string
}

export const CODEX_OAUTH_DEFAULTS: CodexOAuthEndpoints = {
  authUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  redirectUri: 'http://localhost:1455/auth/callback',
}

const AUTH_SCOPE = 'openid email profile offline_access'
const REFRESH_SCOPE = 'openid profile email'

export function buildCodexAuthorizationUrl(
  pkce: PkceCodes,
  state: string,
  endpoints: CodexOAuthEndpoints = CODEX_OAUTH_DEFAULTS,
): string {
  const params = new URLSearchParams({
    client_id: endpoints.clientId,
    response_type: 'code',
    redirect_uri: endpoints.redirectUri,
    scope: AUTH_SCOPE,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    prompt: 'login',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  })
  return `${endpoints.authUrl}?${params.toString()}`
}

interface CodexTokenResponse {
  access_token: string
  refresh_token: string
  id_token: string
  expires_in: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function decodeCodexIdToken(idToken: string): { accountId?: string; email?: string } {
  const parts = idToken.split('.')
  const payloadPart = parts[1]
  if (parts.length !== 3 || payloadPart === undefined) return {}
  try {
    const json = Buffer.from(payloadPart, 'base64url').toString('utf8')
    const payload: unknown = JSON.parse(json)
    if (!isRecord(payload)) return {}
    const email = typeof payload.email === 'string' ? payload.email : undefined
    const authInfo = payload['https://api.openai.com/auth']
    const accountId =
      isRecord(authInfo) && typeof authInfo.chatgpt_account_id === 'string' ? authInfo.chatgpt_account_id : undefined
    return { ...(accountId === undefined ? {} : { accountId }), ...(email === undefined ? {} : { email }) }
  } catch {
    return {}
  }
}

function isTokenResponse(value: unknown): value is CodexTokenResponse {
  return (
    isRecord(value) &&
    typeof value.access_token === 'string' &&
    typeof value.refresh_token === 'string' &&
    typeof value.id_token === 'string' &&
    typeof value.expires_in === 'number'
  )
}

export class CodexOAuthHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Troca/renovação de token Codex falhou com status ${status}`)
    this.name = 'CodexOAuthHttpError'
  }
}

async function requestCodexToken(tokenUrl: string, body: URLSearchParams): Promise<StoredOAuthToken> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
  })
  if (response.status < 200 || response.status >= 300) throw new CodexOAuthHttpError(response.status)
  const parsed: unknown = await response.json()
  if (!isTokenResponse(parsed)) throw new CodexOAuthHttpError(response.status)
  const { accountId, email } = decodeCodexIdToken(parsed.id_token)
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: Date.now() + parsed.expires_in * 1000,
    ...(accountId === undefined ? {} : { accountId }),
    ...(email === undefined ? {} : { email }),
  }
}

export async function exchangeCodexCode(
  code: string,
  pkce: PkceCodes,
  endpoints: CodexOAuthEndpoints = CODEX_OAUTH_DEFAULTS,
): Promise<StoredOAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: endpoints.clientId,
    code,
    redirect_uri: endpoints.redirectUri,
    code_verifier: pkce.verifier,
  })
  return requestCodexToken(endpoints.tokenUrl, body)
}

export async function refreshCodexToken(
  refreshToken: string,
  endpoints: CodexOAuthEndpoints = CODEX_OAUTH_DEFAULTS,
): Promise<StoredOAuthToken> {
  const body = new URLSearchParams({
    client_id: endpoints.clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: REFRESH_SCOPE,
  })
  return requestCodexToken(endpoints.tokenUrl, body)
}
