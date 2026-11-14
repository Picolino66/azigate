import WebSocket from 'ws'
import { WorkspaceMcpServer, localToolCaller } from '../mcp/server.js'
import {
  WORKER_MAX_PAYLOAD_BYTES,
  WORKER_PROTOCOL_VERSION,
  WorkerRpcError,
  parseGatewayMessage,
  type WorkerCapability,
} from '../protocol/protocol.js'
import { frameToText, sendJson } from '../protocol/transport.js'
import type { WorkerHandler } from './handler.js'

export interface WorkspaceConnectionOptions {
  url: URL
  workerId: string
  token: () => string
  handler: WorkerHandler
  version: string
  log: (event: string, fields?: Record<string, string | number | boolean>) => void
  minBackoffMs?: number
  maxBackoffMs?: number
}

const MAX_CHANNELS = 32

/**
 * Conexão de saída do Workspace Server para o agentd (ADR-023/ADR-025): registra, mantém
 * heartbeat, atende RPCs e hospeda canais MCP — um servidor MCP por sessão de agente, preso
 * a um workspace. Reconecta com backoff exponencial.
 */
export class WorkspaceConnection {
  private socket: WebSocket | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private backoffMs: number
  private stopped = false
  private readonly channels = new Map<string, WorkspaceMcpServer>()

  constructor(private readonly options: WorkspaceConnectionOptions) {
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
    this.channels.clear()
    this.socket?.close(1000, 'workspace server encerrando')
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
      const capabilities: WorkerCapability[] = ['filesystem', 'git', 'mcp']
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
      switch (message.type) {
        case 'worker.registered':
          this.backoffMs = this.options.minBackoffMs ?? 1000
          this.options.log('worker_registered', { workspaces: message.workspaces.length })
          if (this.heartbeat) clearInterval(this.heartbeat)
          this.heartbeat = setInterval(() => sendJson(socket, { type: 'worker.heartbeat' }), message.heartbeatIntervalMs)
          this.heartbeat.unref()
          return
        case 'worker.rejected':
          this.options.log('worker_rejected', { code: message.code })
          return
        case 'mcp.open':
          this.openChannel(socket, message.channel, message.workspace)
          return
        case 'mcp.message': {
          const server = this.channels.get(message.channel)
          if (!server) {
            sendJson(socket, { type: 'mcp.closed', channel: message.channel })
            return
          }
          server
            .handle(message.message)
            .then((reply) => {
              if (reply && this.channels.get(message.channel) === server) {
                sendJson(socket, { type: 'mcp.message', channel: message.channel, message: reply })
              }
            })
            .catch(() => undefined)
          return
        }
        case 'mcp.close':
          this.channels.delete(message.channel)
          return
        case 'rpc.request':
          this.options.handler
            .handle(message.workspace, message.method, message.params)
            .then((result) => sendJson(socket, { type: 'rpc.response', id: message.id, ok: true, result }))
            .catch((error: unknown) => {
              const rpcError = error instanceof WorkerRpcError ? error : new WorkerRpcError('io_error', 'Falha inesperada no workspace')
              sendJson(socket, { type: 'rpc.response', id: message.id, ok: false, error: { code: rpcError.code, message: rpcError.message } })
            })
      }
    })
    socket.on('close', (code) => {
      if (this.heartbeat) clearInterval(this.heartbeat)
      this.heartbeat = undefined
      this.channels.clear()
      this.options.log('worker_disconnected', { code })
      this.scheduleReconnect()
    })
    socket.on('unexpected-response', (_request, response) => {
      this.options.log('worker_connect_refused', { status: response.statusCode ?? 0 })
    })
    socket.on('error', () => undefined)
  }

  private openChannel(socket: WebSocket, channel: string, workspace: string): void {
    if (!this.options.handler.workspaceIds.includes(workspace) || this.channels.size >= MAX_CHANNELS) {
      sendJson(socket, { type: 'mcp.closed', channel })
      return
    }
    const handler = this.options.handler
    this.channels.set(channel, new WorkspaceMcpServer(localToolCaller((tool, args) => handler.handle(workspace, tool, args))))
    this.options.log('workspace_mcp_channel_opened', { workspace })
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? 60_000)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }
}
