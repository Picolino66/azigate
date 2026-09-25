import { fetch } from 'undici'
import { OAuthHttpError, readOAuthErrorCode } from './oauth-http-error.js'
import type { PkceCodes } from './pkce.js'
import type { StoredOAuthToken } from './token-store.js'

export interface ClaudeOAuthEndpoints {
  authUrl: string
  tokenUrl: string
  clientId: string
  redirectUri: string
}

export const CLAUDE_OAUTH_DEFAULTS: ClaudeOAuthEndpoints = {
  authUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://api.anthropic.com/v1/oauth/token',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  redirectUri: 'http://localhost:54545/callback',
}

const AUTH_SCOPE = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'

export function buildClaudeAuthorizationUrl(
  pkce: PkceCodes,
  state: string,
  endpoints: ClaudeOAuthEndpoints = CLAUDE_OAUTH_DEFAULTS,
): string {
  const params = new URLSearchParams({
    code: 'true',
    client_id: endpoints.clientId,
    response_type: 'code',
    redirect_uri: endpoints.redirectUri,
    scope: AUTH_SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state,
  })
  return `${endpoints.authUrl}?${params.toString()}`
}

/**
 * O callback do navegador às vezes devolve "code#state" concatenados no mesmo parâmetro,
 * conforme observado no fluxo oficial do Claude Code.
 */
export function splitClaudeCodeAndState(rawCode: string): { code: string; state?: string } {
  const [code, state] = rawCode.split('#')
  return { code: code ?? rawCode, ...(state === undefined || state === '' ? {} : { state }) }
}

interface ClaudeTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  account?: { uuid?: string; email_address?: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTokenResponse(value: unknown): value is ClaudeTokenResponse {
  return (
    isRecord(value) &&
    typeof value.access_token === 'string' &&
    typeof value.refresh_token === 'string' &&
    typeof value.expires_in === 'number'
  )
}

export class ClaudeOAuthHttpError extends OAuthHttpError {
  constructor(status: number, oauthError?: string) {
    super(`Troca/renovação de token Claude falhou com status ${status}`, status, oauthError)
  }
}

async function requestClaudeToken(tokenUrl: string, payload: Record<string, unknown>): Promise<StoredOAuthToken> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
  })
  if (response.status < 200 || response.status >= 300) {
    throw new ClaudeOAuthHttpError(response.status, await readOAuthErrorCode(response))
  }
  const parsed: unknown = await response.json()
  if (!isTokenResponse(parsed)) throw new ClaudeOAuthHttpError(response.status, 'resposta_invalida')
  const email = parsed.account?.email_address
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: Date.now() + parsed.expires_in * 1000,
    ...(email === undefined ? {} : { email }),
  }
}

export async function exchangeClaudeCode(
  rawCode: string,
  state: string,
  pkce: PkceCodes,
  endpoints: ClaudeOAuthEndpoints = CLAUDE_OAUTH_DEFAULTS,
): Promise<StoredOAuthToken> {
  const { code, state: embeddedState } = splitClaudeCodeAndState(rawCode)
  return requestClaudeToken(endpoints.tokenUrl, {
    code,
    state: embeddedState ?? state,
    grant_type: 'authorization_code',
    client_id: endpoints.clientId,
    redirect_uri: endpoints.redirectUri,
    code_verifier: pkce.verifier,
  })
}

export async function refreshClaudeToken(
  refreshToken: string,
  endpoints: ClaudeOAuthEndpoints = CLAUDE_OAUTH_DEFAULTS,
): Promise<StoredOAuthToken> {
  return requestClaudeToken(endpoints.tokenUrl, {
    client_id: endpoints.clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
}
