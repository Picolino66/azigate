import { randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'
import { isRecord } from '../agents/core/agent-event.js'
import type { ApprovalDecision, PermissionMode, RemoteApprovalMode } from '../agents/core/agent-provider.js'
import { LineSplitter, parseJsonLine } from '../agents/core/ndjson.js'
import { MCP_SERVER_NAME, toolError } from '../workspace/mcp/server.js'
import { FILE_MUTATION_METHODS, READ_ONLY_METHODS, WorkerRpcError, isWorkerMethod } from '../workspace/protocol/protocol.js'
import type { McpChannel, WorkerHub } from './workers.js'

export { MCP_SERVER_NAME }

/** Nome da ferramenta como os agentes a exibem (`mcp__<servidor>__<ferramenta>`). */
export function mcpToolName(method: string): string {
  return `mcp__${MCP_SERVER_NAME}__${method}`
}

export const READ_ONLY_MCP_TOOLS = [...READ_ONLY_METHODS].map(mcpToolName)

export type { RemoteApprovalMode }

export interface RelayBinding {
  sessionId: string
  workerId: string
  workspaceId: string
  permissionMode: PermissionMode
  approvals: RemoteApprovalMode
  requestApproval(tool: string, summary: string): Promise<ApprovalDecision>
}

export type ToolPolicy =
  | { action: 'forward' }
  | { action: 'deny'; code: string; message: string }
  | { action: 'approve'; summary: string }

const SUMMARY_LIMIT = 500

export function summarizeWorkspaceCall(tool: string, args: Record<string, unknown>): string {
  const argv = Array.isArray(args.argv) ? args.argv.filter((item): item is string => typeof item === 'string') : undefined
  const path = typeof args.path === 'string' ? args.path : undefined
  const summary = argv && argv.length > 0 ? argv.join(' ') : path ? `${tool} ${path}` : `${tool} ${JSON.stringify(args)}`
  return summary.length > SUMMARY_LIMIT ? `${summary.slice(0, SUMMARY_LIMIT - 1)}…` : summary
}

/** Decide o destino de um `tools/call` antes de ele sair da máquina A. */
export function toolCallPolicy(binding: Pick<RelayBinding, 'permissionMode' | 'approvals'>, tool: string, args: Record<string, unknown>): ToolPolicy {
  if (!isWorkerMethod(tool) || READ_ONLY_METHODS.has(tool)) return { action: 'forward' }
  if (binding.permissionMode === 'plan') {
    return { action: 'deny', code: 'permission_denied', message: 'O modo plan permite somente leitura' }
  }
  if (binding.approvals === 'native') return { action: 'forward' }
  if (binding.permissionMode === 'acceptEdits' && FILE_MUTATION_METHODS.has(tool)) return { action: 'forward' }
  return { action: 'approve', summary: summarizeWorkspaceCall(tool, args) }
}

const MAX_LINE_BYTES = 16 * 1024 * 1024

interface ActiveConnection {
  socket: Socket
  channel: McpChannel | undefined
}

/**
 * Relay MCP entre a ponte stdio que o agente inicia na máquina A e o Workspace Server da
 * máquina B (ADR-025). O servidor MCP de verdade é o de B; aqui só se autentica a sessão
 * pelo token de capacidade, abre o canal e aplica a política de ferramentas.
 */
export class WorkspaceRelay {
  private readonly bindings = new Map<string, RelayBinding>()
  private readonly connections = new Map<string, Set<ActiveConnection>>()
  private readonly revoked = new WeakSet<RelayBinding>()

  constructor(
    private readonly hub: WorkerHub,
    private readonly diagnostic: (event: string, fields?: Record<string, string | number | boolean>) => void = () => undefined,
  ) {}

  issue(binding: RelayBinding): string {
    const token = randomBytes(32).toString('base64url')
    this.bindings.set(token, binding)
    return token
  }

  revokeSession(sessionId: string): void {
    for (const [token, binding] of this.bindings) {
      if (binding.sessionId !== sessionId) continue
      this.bindings.delete(token)
      this.revoked.add(binding)
    }
    for (const connection of this.connections.get(sessionId) ?? []) {
      connection.channel?.close()
      connection.socket.destroy()
    }
    this.connections.delete(sessionId)
  }

  attach(socket: Socket): void {
    let binding: RelayBinding | undefined
    const connection: ActiveConnection = { socket, channel: undefined }
    const write = (payload: unknown): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`)
    }
    const splitter = new LineSplitter(
      MAX_LINE_BYTES,
      (line) => {
        const message = parseJsonLine(line)
        if (!binding) {
          binding = this.authenticate(message)
          if (!binding) {
            write({ type: 'error', code: 'permission_denied', message: 'Token de sessão inválido' })
            socket.end()
            return
          }
          const bound = binding
          try {
            connection.channel = this.hub.openMcpChannel(bound.workerId, bound.workspaceId, {
              onMessage: (reply) => write(reply),
              onClose: () => socket.end(),
            })
          } catch (error) {
            const code = error instanceof WorkerRpcError ? error.code : 'worker_unavailable'
            write({ type: 'error', code, message: 'Workspace server indisponível' })
            socket.end()
            return
          }
          const set = this.connections.get(bound.sessionId) ?? new Set()
          set.add(connection)
          this.connections.set(bound.sessionId, set)
          this.diagnostic('workspace_relay_opened', { sessionId: bound.sessionId, workerId: bound.workerId })
          return
        }
        if (!isRecord(message)) return
        void this.forward(binding, connection, message, write)
      },
      () => socket.destroy(),
    )
    socket.on('data', (chunk: Buffer) => splitter.push(chunk))
    socket.on('error', () => undefined)
    socket.on('close', () => {
      connection.channel?.close()
      if (binding) this.connections.get(binding.sessionId)?.delete(connection)
    })
  }

  private authenticate(message: unknown): RelayBinding | undefined {
    if (!isRecord(message) || message.type !== 'hello' || typeof message.token !== 'string') return undefined
    return this.bindings.get(message.token)
  }

  private async forward(
    binding: RelayBinding,
    connection: ActiveConnection,
    message: Record<string, unknown>,
    write: (payload: unknown) => void,
  ): Promise<void> {
    if (message.method !== 'tools/call') {
      connection.channel?.send(message)
      return
    }
    const params = isRecord(message.params) ? message.params : {}
    const tool = typeof params.name === 'string' ? params.name : ''
    const args = isRecord(params.arguments) ? params.arguments : {}
    const policy = toolCallPolicy(binding, tool, args)
    if (policy.action === 'deny') {
      this.diagnostic('workspace_tool_denied', { sessionId: binding.sessionId, tool, reason: policy.code })
      write(toolError(message.id, policy.code, policy.message))
      return
    }
    if (policy.action === 'approve') {
      const decision = await binding.requestApproval(mcpToolName(tool), policy.summary).catch((): ApprovalDecision => 'deny')
      if (decision !== 'allow' || this.revoked.has(binding)) {
        this.diagnostic('workspace_tool_denied', { sessionId: binding.sessionId, tool, reason: 'approval' })
        write(toolError(message.id, 'permission_denied', 'Negado pelo operador no Azigate'))
        return
      }
    }
    this.diagnostic('workspace_tool_forwarded', { sessionId: binding.sessionId, tool })
    if (!connection.channel?.send(message)) write(toolError(message.id, 'worker_unavailable', 'Workspace server indisponível'))
  }
}
