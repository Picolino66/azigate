import { isRecord } from './agent-event.js'

export type JsonRpcId = string | number

export class JsonRpcRemoteError extends Error {
  override readonly name = 'JsonRpcRemoteError'
  constructor(
    readonly code: number,
    readonly method: string,
  ) {
    super(`Erro JSON-RPC ${code} em ${method}`)
  }
}

export class JsonRpcTimeoutError extends Error {
  override readonly name = 'JsonRpcTimeoutError'
  constructor(readonly method: string) {
    super(`Tempo esgotado aguardando ${method}`)
  }
}

export class JsonRpcClosedError extends Error {
  override readonly name = 'JsonRpcClosedError'
  constructor() {
    super('Conexão JSON-RPC encerrada')
  }
}

export interface JsonRpcHandlers {
  onNotification(method: string, params: unknown, raw: Record<string, unknown>): void
  onServerRequest(id: JsonRpcId, method: string, params: unknown, raw: Record<string, unknown>): void
  onInvalidMessage(): void
}

interface PendingRequest {
  method: string
  resolve(result: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

/**
 * Conexão JSON-RPC delimitada por linha. Segue o framing do `codex app-server`, que omite o
 * campo `jsonrpc`: pedidos `{id, method, params}`, respostas `{id, result|error}`,
 * notificações `{method, params}` e pedidos do servidor `{id, method, params}`.
 */
export class JsonRpcConnection {
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private closed = false

  constructor(
    private readonly send: (message: Record<string, unknown>) => boolean,
    private readonly handlers: JsonRpcHandlers,
  ) {}

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new JsonRpcClosedError())
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new JsonRpcTimeoutError(method))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, { method, resolve, reject, timer })
      if (!this.send({ id, method, params })) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new JsonRpcClosedError())
      }
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.send(params === undefined ? { method } : { method, params })
  }

  respond(id: JsonRpcId, result: unknown): void {
    if (!this.closed) this.send({ id, result })
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    if (!this.closed) this.send({ id, error: { code, message } })
  }

  handleMessage(message: unknown): void {
    if (!isRecord(message)) {
      this.handlers.onInvalidMessage()
      return
    }
    const id = message.id
    const hasId = typeof id === 'string' || typeof id === 'number'
    const method = typeof message.method === 'string' ? message.method : undefined
    if (method && hasId) {
      this.handlers.onServerRequest(id, method, message.params, message)
      return
    }
    if (method) {
      this.handlers.onNotification(method, message.params, message)
      return
    }
    if (hasId) {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if ('error' in message && message.error !== undefined && message.error !== null) {
        const code = isRecord(message.error) && typeof message.error.code === 'number' ? message.error.code : -32000
        pending.reject(new JsonRpcRemoteError(code, pending.method))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    this.handlers.onInvalidMessage()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new JsonRpcClosedError())
    }
    this.pending.clear()
  }
}
