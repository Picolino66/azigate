import { isRecord } from '../../agents/core/agent-event.js'
import {
  EXEC_METHODS,
  READ_ONLY_METHODS,
  WORKER_METHODS,
  WORKER_METHOD_SCHEMAS,
  WorkerRpcError,
  isWorkerMethod,
  type WorkerMethod,
} from '../protocol/protocol.js'

export const MCP_SERVER_NAME = 'azigate_workspace'
export const SUPPORTED_MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
const LATEST_MCP_VERSION = SUPPORTED_MCP_VERSIONS[0]

export type ToolCallResult = { ok: true; result: unknown } | { ok: false; code: string; message: string }
export type ToolCaller = (tool: WorkerMethod, args: Record<string, unknown>) => Promise<ToolCallResult>

type JsonRpcMessage = Record<string, unknown>

const INSTRUCTIONS =
  'Ferramentas do Azigate Workspace Server. O projeto está nesta máquina de workspace, não na máquina do agente. ' +
  'Caminhos são relativos à raiz do workspace; comandos usam argv, sem shell.'

function response(id: unknown, result: unknown): JsonRpcMessage {
  return { jsonrpc: '2.0', id, result }
}

function errorResponse(id: unknown, code: number, message: string): JsonRpcMessage {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** Resultado MCP de erro de ferramenta (não é erro de protocolo: o agente vê a mensagem). */
export function toolError(id: unknown, code: string, message: string): JsonRpcMessage {
  return response(id, { content: [{ type: 'text', text: `${code}: ${message}` }], isError: true })
}

/** Texto devolvido ao modelo: conteúdo bruto para leitura e Git, JSON nos demais casos. */
export function formatToolResult(tool: string, result: unknown): string {
  if (tool === 'read_file' && isRecord(result) && typeof result.content === 'string') {
    return result.truncated === true ? `${result.content}\n\n[conteúdo truncado em 1 MiB]` : result.content
  }
  if ((tool === 'git_status' || tool === 'git_diff' || tool === 'git_log') && isRecord(result) && typeof result.output === 'string') {
    return result.truncated === true ? `${result.output}\n\n[saída truncada]` : result.output
  }
  return JSON.stringify(result, null, 2)
}

export function toolDefinitions(): Record<string, unknown>[] {
  return WORKER_METHODS.map((name) => ({
    name,
    description: WORKER_METHOD_SCHEMAS[name].description,
    inputSchema: WORKER_METHOD_SCHEMAS[name].inputSchema,
    annotations: {
      readOnlyHint: READ_ONLY_METHODS.has(name),
      destructiveHint: !READ_ONLY_METHODS.has(name),
      openWorldHint: EXEC_METHODS.has(name),
    },
  }))
}

/**
 * Servidor MCP (JSON-RPC 2.0) das capacidades de um workspace. Roda na máquina do projeto
 * (Workspace Server) e é agnóstico ao agente: Claude Code, Codex, AGY ou qualquer cliente
 * MCP o consomem da mesma forma (ADR-025). Não chama modelo nem decide nada.
 */
export class WorkspaceMcpServer {
  constructor(private readonly callTool: ToolCaller) {}

  async handle(message: unknown): Promise<JsonRpcMessage | undefined> {
    if (!isRecord(message) || typeof message.method !== 'string') {
      return isRecord(message) && 'id' in message ? errorResponse(message.id ?? null, -32600, 'Invalid Request') : undefined
    }
    const hasId = typeof message.id === 'string' || typeof message.id === 'number'
    if (!hasId) return undefined
    const id = message.id
    const params = isRecord(message.params) ? message.params : {}
    switch (message.method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : LATEST_MCP_VERSION
        const protocolVersion = (SUPPORTED_MCP_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST_MCP_VERSION
        return response(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'azigate-workspace', version: '2' },
          instructions: INSTRUCTIONS,
        })
      }
      // O AGY abre a sessão com `server/discover` (não padronizado) antes do initialize.
      case 'ping':
      case 'server/discover':
        return response(id, {})
      case 'tools/list':
        return response(id, { tools: toolDefinitions() })
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        if (!isWorkerMethod(name)) return errorResponse(id, -32602, `Ferramenta desconhecida: ${name.slice(0, 64)}`)
        const args = isRecord(params.arguments) ? params.arguments : {}
        const outcome = await this.callTool(name, args)
        return outcome.ok
          ? response(id, { content: [{ type: 'text', text: formatToolResult(name, outcome.result) }], isError: false })
          : toolError(id, outcome.code, outcome.message)
      }
      default:
        return errorResponse(id, -32601, 'Method not found')
    }
  }
}

/** Liga o servidor MCP a um executor local de métodos do workspace. */
export function localToolCaller(execute: (tool: WorkerMethod, args: Record<string, unknown>) => Promise<unknown>): ToolCaller {
  return async (tool, args) => {
    try {
      return { ok: true, result: await execute(tool, args) }
    } catch (error) {
      if (error instanceof WorkerRpcError) return { ok: false, code: error.code, message: error.message }
      return { ok: false, code: 'io_error', message: 'Falha inesperada no workspace' }
    }
  }
}
