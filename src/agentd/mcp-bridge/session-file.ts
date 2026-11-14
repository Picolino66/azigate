import { readFileSync, statSync } from 'node:fs'

export interface BridgeSession {
  socket: string
  token: string
}

/**
 * Lê o arquivo de sessão (0600) que o agentd escreve no diretório privado da sessão. O token
 * fica só aqui: nunca em argv nem na configuração MCP que o agente recebe (ADR-025).
 */
export function readBridgeSession(path: string): BridgeSession {
  const info = statSync(path)
  if ((info.mode & 0o077) !== 0) throw new Error('O arquivo de sessão MCP precisa ter permissão 0600')
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BridgeSession>
  if (typeof parsed.socket !== 'string' || typeof parsed.token !== 'string') {
    throw new Error('Arquivo de sessão MCP inválido')
  }
  return { socket: parsed.socket, token: parsed.token }
}

/** Resposta de um servidor MCP sem ferramentas, usada fora de uma sessão Azigate. */
export function idleMcpResponse(message: unknown): Record<string, unknown> | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const record = message as Record<string, unknown>
  if (typeof record.id !== 'string' && typeof record.id !== 'number') return undefined
  const id = record.id
  switch (record.method) {
    case 'initialize': {
      const params = typeof record.params === 'object' && record.params !== null ? (record.params as Record<string, unknown>) : {}
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'azigate-workspace', version: '2' },
          instructions: 'Sem sessão do Azigate: nenhum workspace remoto disponível.',
        },
      }
    }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: [] } }
    case 'ping':
    case 'server/discover':
      return { jsonrpc: '2.0', id, result: {} }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }
  }
}
