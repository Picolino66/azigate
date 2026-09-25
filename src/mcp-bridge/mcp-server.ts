import { isRecord } from '../agents/core/agent-event.js'
import { WORKER_METHODS, WORKER_METHOD_SCHEMAS } from '../worker-protocol/protocol.js'

export const SUPPORTED_MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
const LATEST_MCP_VERSION = SUPPORTED_MCP_VERSIONS[0]

export type ToolCallResult = { ok: true; result: unknown } | { ok: false; code: string; message: string }
export type ToolCaller = (tool: string, args: Record<string, unknown>) => Promise<ToolCallResult>

type JsonRpcResponse = Record<string, unknown>

function response(id: unknown, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function errorResponse(id: unknown, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** Texto devolvido ao modelo: conteúdo bruto para leitura de arquivo, JSON nos demais casos. */
export function formatToolResult(tool: string, result: unknown): string {
  if (tool === 'read_file' && isRecord(result) && typeof result.content === 'string') {
    return result.truncated === true ? `${result.content}\n\n[conteúdo truncado em 1 MiB]` : result.content
  }
  if ((tool === 'git_status' || tool === 'git_diff' || tool === 'git_log') && isRecord(result) && typeof result.output === 'string') {
    return result.truncated === true ? `${result.output}\n\n[saída truncada]` : result.output
  }
  return JSON.stringify(result, null, 2)
}

/**
 * Servidor MCP mínimo (stdio, JSON-RPC 2.0) com as ferramentas do workspace remoto. Não
 * executa nada localmente: toda chamada vai ao agentd, que encaminha ao worker (ADR-023).
 */
export class WorkspaceMcpServer {
  constructor(private readonly callTool: ToolCaller) {}

  async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (!isRecord(message) || typeof message.method !== 'string') {
      return isRecord(message) && 'id' in message ? errorResponse(message.id ?? null, -32600, 'Invalid Request') : undefined
    }
    const hasId = 'id' in message && (typeof message.id === 'string' || typeof message.id === 'number')
    if (!hasId) return undefined
    const id = message.id
    const params = isRecord(message.params) ? message.params : {}
    switch (message.method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : LATEST_MCP_VERSION
        const protocolVersion = (SUPPORTED_MCP_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : LATEST_MCP_VERSION
        return response(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'azigate-workspace', version: '1' },
          instructions:
            'Ferramentas do workspace remoto do Azigate. Paths são relativos à raiz do workspace; comandos usam argv, sem shell.',
        })
      }
      case 'ping':
        return response(id, {})
      case 'tools/list':
        return response(id, {
          tools: WORKER_METHODS.map((name) => ({
            name,
            description: WORKER_METHOD_SCHEMAS[name].description,
            inputSchema: WORKER_METHOD_SCHEMAS[name].inputSchema,
          })),
        })
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        if (!(WORKER_METHODS as readonly string[]).includes(name)) {
          return errorResponse(id, -32602, `Ferramenta desconhecida: ${name.slice(0, 64)}`)
        }
        const args = isRecord(params.arguments) ? params.arguments : {}
        const outcome = await this.callTool(name, args)
        return outcome.ok
          ? response(id, { content: [{ type: 'text', text: formatToolResult(name, outcome.result) }], isError: false })
          : response(id, { content: [{ type: 'text', text: `${outcome.code}: ${outcome.message}` }], isError: true })
      }
      default:
        return errorResponse(id, -32601, 'Method not found')
    }
  }
}
