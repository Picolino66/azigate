import { describe, expect, it } from 'vitest'
import { extractOAuthErrorCode, sanitizeOAuthErrorCode } from '../src/providers/oauth/oauth-http-error.js'

describe('oauth-http-error', () => {
  it('aceita o código OAuth da RFC 6749', () => {
    expect(extractOAuthErrorCode({ error: 'invalid_grant', error_description: 'texto livre' })).toBe('invalid_grant')
  })

  it('aceita o formato aninhado, preferindo code a type', () => {
    expect(extractOAuthErrorCode({ error: { type: 'invalid_request_error', message: 'x' } })).toBe('invalid_request_error')
    expect(extractOAuthErrorCode({ error: { code: 'token_expired', type: 'invalid_request_error' } })).toBe('token_expired')
  })

  it('descarta valores fora da allowlist e formatos desconhecidos', () => {
    expect(extractOAuthErrorCode({ error: 'refresh token abc123 inválido' })).toBeUndefined()
    expect(extractOAuthErrorCode({ error: 'a'.repeat(65) })).toBeUndefined()
    expect(extractOAuthErrorCode({ message: 'invalid_grant' })).toBeUndefined()
    expect(extractOAuthErrorCode('invalid_grant')).toBeUndefined()
    expect(extractOAuthErrorCode(null)).toBeUndefined()
    expect(sanitizeOAuthErrorCode(42)).toBeUndefined()
  })
})
