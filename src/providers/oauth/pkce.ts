import { createHash, randomBytes } from 'node:crypto'

export interface PkceCodes {
  verifier: string
  challenge: string
}

export function generatePkceCodes(): PkceCodes {
  const verifier = randomBytes(96).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url')
}
