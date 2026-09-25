import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { isRecord } from '../agents/core/agent-event.js'
import { LineSplitter, parseJsonLine } from '../agents/core/ndjson.js'
import type { RemoteToolGateway } from '../agent-control/remote-tools.js'
import { WorkerRpcError } from '../worker-protocol/protocol.js'

const MAX_LINE_BYTES = 8 * 1024 * 1024

function removeStaleSocket(path: string): void {
  try {
    if (lstatSync(path).isSocket()) unlinkSync(path)
    else throw new Error('AGENT_MCP_SOCKET aponta para um arquivo que não é socket')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function handleConnection(socket: Socket, gateway: RemoteToolGateway): void {
  const reply = (payload: unknown): void => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`)
  }
  const splitter = new LineSplitter(
    MAX_LINE_BYTES,
    (line) => {
      const message = parseJsonLine(line)
      if (!isRecord(message) || (typeof message.id !== 'number' && typeof message.id !== 'string')) {
        socket.destroy()
        return
      }
      const id = message.id
      gateway
        .call(message.token, message.tool, message.arguments)
        .then((result) => reply({ id, ok: true, result }))
        .catch((error: unknown) => {
          const code = error instanceof WorkerRpcError ? error.code : 'io_error'
          const text = error instanceof WorkerRpcError ? error.message : 'Falha ao executar a ferramenta remota'
          reply({ id, ok: false, error: { code, message: text } })
        })
    },
    () => socket.destroy(),
  )
  socket.on('data', (chunk: Buffer) => splitter.push(chunk))
  socket.on('error', () => undefined)
}

/**
 * Socket Unix privado (0600) entre o `azigate-mcp-bridge` e o agentd (ADR-023). Cada linha
 * é uma chamada de ferramenta autenticada pelo token de capacidade da sessão.
 */
export async function startMcpSocketServer(path: string, gateway: RemoteToolGateway): Promise<Server> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  removeStaleSocket(path)
  const server = createServer((socket) => handleConnection(socket, gateway))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // O bind do socket Unix acontece dentro de listen(); a umask evita a janela com 0755.
    const previousUmask = process.umask(0o177)
    try {
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    } finally {
      process.umask(previousUmask)
    }
  })
  chmodSync(path, 0o600)
  return server
}
