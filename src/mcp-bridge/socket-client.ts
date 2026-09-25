import { connect, type Socket } from 'node:net'
import { isRecord } from '../agents/core/agent-event.js'
import { LineSplitter, parseJsonLine } from '../agents/core/ndjson.js'
import type { ToolCallResult } from './mcp-server.js'

const MAX_LINE_BYTES = 16 * 1024 * 1024

interface Pending {
  resolve(result: ToolCallResult): void
}

/** Cliente do socket Unix privado do agentd, com correlação por `id`. */
export class AgentdSocketClient {
  private socket: Socket | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
  ) {}

  call(tool: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const socket = this.ensureSocket()
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, { resolve })
      socket.write(`${JSON.stringify({ id, token: this.token, tool, arguments: args })}\n`)
    })
  }

  close(): void {
    this.socket?.end()
  }

  private ensureSocket(): Socket {
    if (this.socket && !this.socket.destroyed) return this.socket
    const socket = connect(this.socketPath)
    const splitter = new LineSplitter(
      MAX_LINE_BYTES,
      (line) => this.handleLine(line),
      () => socket.destroy(),
    )
    socket.on('data', (chunk: Buffer) => splitter.push(chunk))
    socket.on('error', () => undefined)
    socket.on('close', () => {
      for (const pending of this.pending.values()) {
        pending.resolve({ ok: false, code: 'worker_unavailable', message: 'Conexão com o agentd encerrada' })
      }
      this.pending.clear()
      if (this.socket === socket) this.socket = undefined
    })
    this.socket = socket
    return socket
  }

  private handleLine(line: string): void {
    const message = parseJsonLine(line)
    if (!isRecord(message) || typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.ok === true) {
      pending.resolve({ ok: true, result: message.result })
      return
    }
    const error = isRecord(message.error) ? message.error : {}
    pending.resolve({
      ok: false,
      code: typeof error.code === 'string' ? error.code : 'io_error',
      message: typeof error.message === 'string' ? error.message : 'Falha na ferramenta remota',
    })
  }
}
