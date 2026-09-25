import { randomBytes } from 'node:crypto'
import { isRecord } from '../agents/core/agent-event.js'
import type { PermissionMode } from '../agents/core/agent-provider.js'
import { READ_ONLY_METHODS, WorkerRpcError, isWorkerMethod } from '../worker-protocol/protocol.js'
import type { WorkerHub } from './workers.js'

export const MCP_SERVER_NAME = 'azigate_workspace'

/** Nome da ferramenta como o Claude Code a enxerga (`mcp__<servidor>__<ferramenta>`). */
export function mcpToolName(method: string): string {
  return `mcp__${MCP_SERVER_NAME}__${method}`
}

export const READ_ONLY_MCP_TOOLS = [...READ_ONLY_METHODS].map(mcpToolName)

interface Binding {
  sessionId: string
  workerId: string
  workspaceId: string
  permissionMode: PermissionMode
}

const DEFAULT_RPC_TIMEOUT_MS = 30_000
const EXEC_DEFAULT_TIMEOUT_MS = 120_000
const EXEC_MARGIN_MS = 5_000

/**
 * Ponte entre as ferramentas MCP de uma sessão e o worker remoto. Cada sessão recebe um
 * token de capacidade aleatório; o token só dá acesso ao worker e workspace da própria
 * sessão, e o modo `plan` só permite métodos somente leitura (ADR-023).
 */
export class RemoteToolGateway {
  private readonly bindings = new Map<string, Binding>()

  constructor(private readonly hub: WorkerHub) {}

  issue(binding: Binding): string {
    const token = randomBytes(32).toString('base64url')
    this.bindings.set(token, binding)
    return token
  }

  revokeSession(sessionId: string): void {
    for (const [token, binding] of this.bindings) {
      if (binding.sessionId === sessionId) this.bindings.delete(token)
    }
  }

  async call(token: unknown, tool: unknown, args: unknown): Promise<unknown> {
    const binding = typeof token === 'string' ? this.bindings.get(token) : undefined
    if (!binding) throw new WorkerRpcError('permission_denied', 'Token de sessão inválido')
    if (!isWorkerMethod(tool)) throw new WorkerRpcError('method_not_found', 'Ferramenta desconhecida')
    if (binding.permissionMode === 'plan' && !READ_ONLY_METHODS.has(tool)) {
      throw new WorkerRpcError('permission_denied', 'O modo plan permite somente leitura')
    }
    const params = isRecord(args) ? args : {}
    let timeoutMs = DEFAULT_RPC_TIMEOUT_MS
    if (tool === 'shell_exec') {
      const requested = typeof params.timeoutMs === 'number' ? params.timeoutMs : EXEC_DEFAULT_TIMEOUT_MS
      timeoutMs = Math.min(Math.max(requested, 1), 600_000) + EXEC_MARGIN_MS
    }
    return this.hub.call(binding.workerId, binding.workspaceId, tool, params, timeoutMs)
  }
}
