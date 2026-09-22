export const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - Date.now())
}

// Converte o cabeçalho do fornecedor em segundos inteiros. Descarta qualquer valor que
// não seja número nem data HTTP válida, então o que é propagado ao cliente é sempre
// um dígito gerado pelo gateway.
export function retryAfterSeconds(value: string | null): string | undefined {
  const ms = parseRetryAfter(value)
  if (ms === undefined) return undefined
  return String(Math.max(0, Math.ceil(ms / 1000)))
}

export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Operação cancelada'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('Operação cancelada'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
