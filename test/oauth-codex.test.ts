import { describe, expect, it } from 'vitest'
import {
  buildCodexAuthorizationUrl,
  CodexOAuthHttpError,
  exchangeCodexCode,
  refreshCodexToken,
  type CodexOAuthEndpoints,
} from '../src/providers/oauth/codex-oauth.js'
import { generateOAuthState, generatePkceCodes } from '../src/providers/oauth/pkce.js'
import { jsonResponse, MockUpstream } from './mock-upstream.js'

function fakeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.`
}

describe('codex oauth', () => {
  it('constrói a URL de autorização com PKCE, state e os parâmetros fixos do fluxo Codex', () => {
    const pkce = generatePkceCodes()
    const state = generateOAuthState()
    const url = new URL(buildCodexAuthorizationUrl(pkce, state))
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(state)
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    expect(url.searchParams.get('scope')).toBe('openid email profile offline_access')
  })

  it('troca o código por tokens e extrai account_id/email do id_token', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    const endpoints: CodexOAuthEndpoints = {
      authUrl: 'https://auth.openai.com/oauth/authorize',
      tokenUrl: new URL('/oauth/token', base).toString(),
      clientId: 'app_test',
      redirectUri: 'http://localhost:1455/auth/callback',
    }
    mock.setHandler((request, response) => {
      expect(request.method).toBe('POST')
      expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded')
      const params = new URLSearchParams(request.body)
      expect(params.get('grant_type')).toBe('authorization_code')
      expect(params.get('client_id')).toBe('app_test')
      expect(params.get('code')).toBe('auth-code-1')
      expect(params.get('code_verifier')).toBeTruthy()
      jsonResponse(response, 200, {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        id_token: fakeIdToken({ email: 'dev@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1' } }),
        token_type: 'Bearer',
        expires_in: 3600,
      })
    })

    const pkce = generatePkceCodes()
    const token = await exchangeCodexCode('auth-code-1', pkce, endpoints)
    expect(token.accessToken).toBe('access-1')
    expect(token.refreshToken).toBe('refresh-1')
    expect(token.accountId).toBe('acct_1')
    expect(token.email).toBe('dev@example.com')
    expect(token.expiresAt).toBeGreaterThan(Date.now())

    await mock.close()
  })

  it('renova o token via refresh_token com o scope reduzido esperado', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    const endpoints: CodexOAuthEndpoints = {
      authUrl: 'https://auth.openai.com/oauth/authorize',
      tokenUrl: new URL('/oauth/token', base).toString(),
      clientId: 'app_test',
      redirectUri: 'http://localhost:1455/auth/callback',
    }
    mock.setHandler((request, response) => {
      const params = new URLSearchParams(request.body)
      expect(params.get('grant_type')).toBe('refresh_token')
      expect(params.get('scope')).toBe('openid profile email')
      expect(params.get('refresh_token')).toBe('refresh-1')
      jsonResponse(response, 200, {
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        id_token: fakeIdToken({}),
        token_type: 'Bearer',
        expires_in: 60,
      })
    })

    const token = await refreshCodexToken('refresh-1', endpoints)
    expect(token.accessToken).toBe('access-2')
    expect(token.refreshToken).toBe('refresh-2')
    expect(token.accountId).toBeUndefined()

    await mock.close()
  })

  it('lança CodexOAuthHttpError quando o endpoint de token responde com erro', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    const endpoints: CodexOAuthEndpoints = {
      authUrl: 'https://auth.openai.com/oauth/authorize',
      tokenUrl: new URL('/oauth/token', base).toString(),
      clientId: 'app_test',
      redirectUri: 'http://localhost:1455/auth/callback',
    }
    mock.setHandler((_request, response) => {
      jsonResponse(response, 400, { error: 'invalid_grant' })
    })

    const pkce = generatePkceCodes()
    await expect(exchangeCodexCode('code-invalido', pkce, endpoints)).rejects.toBeInstanceOf(CodexOAuthHttpError)

    await mock.close()
  })

  it('extrai o código do formato de erro aninhado no refresh Codex', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    const endpoints: CodexOAuthEndpoints = {
      authUrl: 'https://auth.openai.com/oauth/authorize',
      tokenUrl: new URL('/oauth/token', base).toString(),
      clientId: 'app_test',
      redirectUri: 'http://localhost:1455/auth/callback',
    }
    mock.setHandler((_request, response) => {
      jsonResponse(response, 401, { error: { code: 'refresh_token_reused', message: 'MENSAGEM_LIVRE' } })
    })

    const error: unknown = await refreshCodexToken('refresh-1', endpoints).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CodexOAuthHttpError)
    expect(error).toMatchObject({ status: 401, oauthError: 'refresh_token_reused' })

    await mock.close()
  })
})
