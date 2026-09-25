/** Subconjunto do `WebSocket` do pacote `ws` usado pelos dois lados do protocolo. */
export interface WorkerSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): unknown
  on(event: 'close', listener: (code: number) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export const SOCKET_OPEN = 1

export const CLOSE_CODES = {
  normal: 1000,
  unsupportedData: 1003,
  unauthorized: 4401,
  rejected: 4403,
  heartbeatTimeout: 4408,
  replaced: 4409,
} as const

export function sendJson(socket: WorkerSocket, payload: unknown): boolean {
  if (socket.readyState !== SOCKET_OPEN) return false
  socket.send(JSON.stringify(payload))
  return true
}

export function frameToText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}
