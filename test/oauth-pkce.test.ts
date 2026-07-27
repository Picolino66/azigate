import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateOAuthState, generatePkceCodes } from '../src/providers/oauth/pkce.js'

describe('oauth pkce', () => {
  it('gera verifier/challenge coerentes com S256 (RFC 7636)', () => {
    const { verifier, challenge } = generatePkceCodes()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    const expectedChallenge = createHash('sha256').update(verifier).digest('base64url')
    expect(challenge).toBe(expectedChallenge)
  })

  it('gera pares diferentes a cada chamada', () => {
    const first = generatePkceCodes()
    const second = generatePkceCodes()
    expect(first.verifier).not.toBe(second.verifier)
    expect(first.challenge).not.toBe(second.challenge)
  })

  it('gera state url-safe e não determinístico', () => {
    const a = generateOAuthState()
    const b = generateOAuthState()
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a).not.toBe(b)
  })
})
