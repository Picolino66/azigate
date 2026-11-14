import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { dirname } from 'node:path'
import type { WorkspaceRelay } from '../agent-control/workspace-relay.js'

function removeStaleSocket(path: string): void {
  try {
    if (lstatSync(path).isSocket()) unlinkSync(path)
    else throw new Error('AGENT_MCP_SOCKET aponta para um arquivo que não é socket')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * Socket Unix privado (0600) entre a ponte MCP dos agentes e o relay do agentd (ADR-025).
 * Cada conexão começa com `{"type":"hello","token":"…"}` e depois carrega JSON-RPC MCP.
 */
export async function startMcpSocketServer(path: string, relay: WorkspaceRelay): Promise<Server> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  removeStaleSocket(path)
  const server = createServer((socket) => relay.attach(socket))
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
