import { describe, expect, it } from 'vitest'
import {
  buildClaudeAuthorizationUrl,
  ClaudeOAuthHttpError,
  exchangeClaudeCode,
  refreshClaudeToken,
  splitClaudeCodeAndState,
  type ClaudeOAuthEndpoints,
} from '../src/providers/oauth/claude-oauth.js'
import { generateOAuthState, generatePkceCodes } from '../src/providers/oauth/pkce.js'
import { jsonResponse, MockUpstream } from './mock-upstream.js'

describe('claude oauth', () => {
  it('constrói a URL de autorização com PKCE, state e os parâmetros fixos do fluxo Claude', () => {
    const pkce = generatePkceCodes()
    const state = generateOAuthState()
    const url = new URL(buildClaudeAuthorizationUrl(pkce, state))
    expect(url.origin + url.pathname).toBe('https://claude.ai/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e')
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge)
    expect(url.searchParams.get('scope')).toBe('user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload')
    expect(url.searchParams.get('state')).toBe(state)
  })

  it('separa code#state quando o callback devolve os dois concatenados', () => {
    expect(splitClaudeCodeAndState('abc123#state-xyz')).toEqual({ code: 'abc123', state: 'state-xyz' })
    expect(splitClaudeCodeAndState('abc123')).toEqual({ code: 'abc123' })
  })

  it('troca o código por tokens usando corpo JSON e extrai o email da conta', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    const endpoints: ClaudeOAuthEndpoints = {
      authUrl: 'https://claude.ai/oauth/authorize',
      tokenUrl: new URL('/v1/oauth/token', base).toString(),
      clientId: 'client-test',
      redirectUri: 'http://localhost:54545/callback',
    }
    mock.setHandler((request, response) => {
      expect(request.headers['content-type']).toBe('application/json')
      const body = JSON.parse(request.body) as Record<string, unknown>
      expect(body.grant_type).toBe('authorization_code')
      expect(body.client_id).toBe('client-test')
      expect(body.code).toBe('auth-code-1')
      expect(body.state).toBe('state-1')
      jsonResponse(response, 200, {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
        expires_in: 3600,
        account: { uuid: 'acct-uuid', email_address: 'dev@example.com' },
      })
    })

    const pkce = generatePkceCodes()
    const token = await exchangeClaudeCode('auth-code-1#state-1', 'state-1', pkce, endpoints)
    expect(token.accessToken).toBe('access-1')
    expect(token.refreshToken).toBe('refresh-1')
    expect(token.email).toBe('dev@example.com')
    expect(token.expiresAt).toBeGreaterThan(Date.now())

    await mock.close()
  })

  it('renova o token via refresh_token', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    const endpoints: ClaudeOAuthEndpoints = {
      authUrl: 'https://claude.ai/oauth/authorize',
      tokenUrl: new URL('/v1/oauth/token', base).toString(),
      clientId: 'client-test',
      redirectUri: 'http://localhost:54545/callback',
    }
    mock.setHandler((request, response) => {
      const body = JSON.parse(request.body) as Record<string, unknown>
      expect(body.grant_type).toBe('refresh_token')
      expect(body.refresh_token).toBe('refresh-1')
      jsonResponse(response, 200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 60 })
    })

    const token = await refreshClaudeToken('refresh-1', endpoints)
    expect(token.accessToken).toBe('access-2')
    expect(token.email).toBeUndefined()

    await mock.close()
  })

  it('lança ClaudeOAuthHttpError quando o endpoint de token responde com erro', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    const endpoints: ClaudeOAuthEndpoints = {
      authUrl: 'https://claude.ai/oauth/authorize',
      tokenUrl: new URL('/v1/oauth/token', base).toString(),
      clientId: 'client-test',
      redirectUri: 'http://localhost:54545/callback',
    }
    mock.setHandler((_request, response) => {
      jsonResponse(response, 400, { error: 'invalid_grant' })
    })

    const pkce = generatePkceCodes()
    await expect(exchangeClaudeCode('code-invalido', 'state', pkce, endpoints)).rejects.toBeInstanceOf(ClaudeOAuthHttpError)

    await mock.close()
  })

  it('preserva status e código OAuth sanitizado quando o refresh é recusado, sem a descrição livre', async () => {
    const mock = new MockUpstream()
    const base = await mock.start()
    const endpoints: ClaudeOAuthEndpoints = {
      authUrl: 'https://claude.ai/oauth/authorize',
      tokenUrl: new URL('/v1/oauth/token', base).toString(),
      clientId: 'client-test',
      redirectUri: 'http://localhost:54545/callback',
    }
    mock.setHandler((_request, response) => {
      jsonResponse(response, 400, { error: 'invalid_grant', error_description: 'DESCRICAO_SENSIVEL refresh-1' })
    })

    const error: unknown = await refreshClaudeToken('refresh-1', endpoints).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClaudeOAuthHttpError)
    expect(error).toMatchObject({ status: 400, oauthError: 'invalid_grant' })
    expect(JSON.stringify(error)).not.toContain('DESCRICAO_SENSIVEL')
    expect((error as Error).message).not.toContain('DESCRICAO_SENSIVEL')

    await mock.close()
  })
})
