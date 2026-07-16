export function sanitizeText(value: string, secrets: readonly string[]): string {
  let sanitized = value
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join('[SEGREDO_REMOVIDO]')
  }
  return sanitized
}

export function safeError(error: unknown): string {
  if (error instanceof Error) return error.name
  return 'ErroDesconhecido'
}
