import WebSocket from 'ws'
import {
  WORKER_MAX_PAYLOAD_BYTES,
  WORKER_PROTOCOL_VERSION,
  WorkerRpcError,
  parseGatewayMessage,
  type WorkerCapability,
} from '../worker-protocol/protocol.js'
import { frameToText, sendJson } from '../worker-protocol/transport.js'
import type { WorkerHandler } from './handler.js'

export interface WorkerClientOptions {
  url: URL
  workerId: string
  token: () => string
  handler: WorkerHandler
  version: string
  log: (event: string, fields?: Record<string, string | number | boolean>) => void
  minBackoffMs?: number
  maxBackoffMs?: number
}

/**
 * Conexão de saída do worker para o agentd (ADR-023): registra, mantém heartbeat,
 * responde RPCs e reconecta com backoff exponencial.
 */
export class WorkerClient {
  private socket: WebSocket | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private backoffMs: number
  private stopped = false

  constructor(private readonly options: WorkerClientOptions) {
    this.backoffMs = options.minBackoffMs ?? 1000
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.socket?.close(1000, 'worker encerrando')
  }

  private connect(): void {
    let token: string
    try {
      token = this.options.token()
    } catch {
      this.options.log('worker_token_unreadable')
      this.scheduleReconnect()
      return
    }
    const socket = new WebSocket(this.options.url, {
      headers: { authorization: `Bearer ${token}` },
      maxPayload: WORKER_MAX_PAYLOAD_BYTES,
      handshakeTimeout: 15_000,
    })
    this.socket = socket
    socket.on('open', () => {
      const capabilities: WorkerCapability[] = ['filesystem', 'git']
      if (this.options.handler.execEnabled) capabilities.push('exec')
      sendJson(socket, {
        type: 'worker.register',
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerId: this.options.workerId,
        workerVersion: this.options.version,
        capabilities,
        workspaces: this.options.handler.workspaceIds,
      })
    })
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      const message = parseGatewayMessage(frameToText(data))
      if (!message) return
      if (message.type === 'worker.registered') {
        this.backoffMs = this.options.minBackoffMs ?? 1000
        this.options.log('worker_registered', { workspaces: message.workspaces.length })
        if (this.heartbeat) clearInterval(this.heartbeat)
        this.heartbeat = setInterval(() => sendJson(socket, { type: 'worker.heartbeat' }), message.heartbeatIntervalMs)
        this.heartbeat.unref()
        return
      }
      if (message.type === 'worker.rejected') {
        this.options.log('worker_rejected', { code: message.code })
        return
      }
      this.options.handler
        .handle(message.workspace, message.method, message.params)
        .then((result) => sendJson(socket, { type: 'rpc.response', id: message.id, ok: true, result }))
        .catch((error: unknown) => {
          const rpcError =
            error instanceof WorkerRpcError ? error : new WorkerRpcError('io_error', 'Falha inesperada no worker')
          sendJson(socket, {
            type: 'rpc.response',
            id: message.id,
            ok: false,
            error: { code: rpcError.code, message: rpcError.message },
          })
        })
    })
    socket.on('close', (code) => {
      if (this.heartbeat) clearInterval(this.heartbeat)
      this.heartbeat = undefined
      this.options.log('worker_disconnected', { code })
      this.scheduleReconnect()
    })
    socket.on('unexpected-response', (_request, response) => {
      this.options.log('worker_connect_refused', { status: response.statusCode ?? 0 })
    })
    socket.on('error', () => undefined)
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? 60_000)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }
}
