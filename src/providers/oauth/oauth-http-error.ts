import type { Response } from 'undici'

// Corpo de erro do endpoint de token é pequeno; o limite só protege contra resposta anômala.
const MAX_ERROR_BODY_BYTES = 4096
// Códigos OAuth (RFC 6749 §5.2) e tipos de erro dos fornecedores são identificadores curtos.
// Qualquer outro valor é descartado: `error_description` e mensagens livres nunca são registrados.
const SAFE_OAUTH_ERROR = /^[a-z][a-z0-9_.-]{0,63}$/i

export class OAuthHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly oauthError?: string,
  ) {
    super(message)
    this.name = new.target.name
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function sanitizeOAuthErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_OAUTH_ERROR.test(value) ? value : undefined
}

/**
 * Extrai apenas o código de erro OAuth, aceitando `{"error":"invalid_grant"}` (RFC 6749)
 * e `{"error":{"type"|"code":"..."}}` (formato Anthropic/OpenAI).
 */
export function extractOAuthErrorCode(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const { error } = body
  if (typeof error === 'string') return sanitizeOAuthErrorCode(error)
  if (!isRecord(error)) return undefined
  return sanitizeOAuthErrorCode(error.code) ?? sanitizeOAuthErrorCode(error.type)
}

async function readLimitedText(response: Response): Promise<string> {
  if (!response.body) return ''
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk as Uint8Array)
    chunks.push(buffer)
    size += buffer.length
    if (size >= MAX_ERROR_BODY_BYTES) break
  }
  return Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY_BYTES).toString('utf8')
}

export async function readOAuthErrorCode(response: Response): Promise<string | undefined> {
  try {
    return extractOAuthErrorCode(JSON.parse(await readLimitedText(response)))
  } catch {
    return undefined
  }
}
