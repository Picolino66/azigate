import type { AgentEventDraft } from './agent-event.js'

export const AGENT_PROVIDER_IDS = ['codex', 'claude', 'agy'] as const
export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number]

export const PERMISSION_MODES = ['review', 'acceptEdits', 'plan'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** Workspace já resolvido pelo agentd. O cliente só informa o identificador. */
export type WorkspaceTarget =
  | { kind: 'local'; id: string; root: string }
  | { kind: 'remote'; id: string; workerId: string; mcpConfigPath: string; allowedTools: readonly string[] }

export interface AgentSessionOptions {
  sessionId: string
  workspace: WorkspaceTarget
  /** Diretório privado (0700) da sessão; cwd do agente quando o workspace é remoto. */
  sessionDir: string
  permissionMode: PermissionMode
  model?: string
  effort?: string
}

export interface ApprovalRequest {
  tool: string
  summary: string
  native: unknown
  /** Abortado quando o próprio agente desiste do pedido; a aprovação vira `cancelled`. */
  signal?: AbortSignal
}

export type ApprovalDecision = 'allow' | 'deny'

export interface AgentSessionContext {
  /** Cria uma aprovação do Azigate e resolve quando o cliente decide ou ela expira (negação). */
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>
  /** Evento fora de um turno (por exemplo, mensagem nativa entre turnos). */
  emit(event: AgentEventDraft): void
  /** Diagnóstico somente com metadados; nunca recebe conteúdo. */
  diagnostic(event: string, fields?: Record<string, string | number | boolean>): void
}

export interface AgentInput {
  turnId: string
  text: string
}

export interface ProcessExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface AgentRuntimeSession {
  readonly nativeSessionId: string | undefined
  readonly model: string | undefined
  /**
   * Inicia um turno. O iterável termina depois de emitir `turn.completed` ou `turn.failed`.
   * Se o processo morrer, emite `turn.failed` com `agent_process_exited` e termina.
   */
  startTurn(input: AgentInput): AsyncIterable<AgentEventDraft>
  /** Pede a interrupção do turno atual; o iterável termina com `turn_cancelled`. */
  cancelTurn(): Promise<void>
  /** Encerra o processo nativo. Idempotente. */
  close(): Promise<void>
  /** Chamado uma vez quando o processo termina, esperado ou não. */
  onExit(listener: (info: ProcessExitInfo) => void): void
}

export interface AgentProviderHealth {
  installed: boolean
  authenticated: boolean | null
  version: string | null
}

export interface AgentProvider {
  readonly id: AgentProviderId
  readonly adapterVersion: string
  readonly protocolVersion: string
  readonly supportsRemoteWorkspace: boolean
  readonly efforts: readonly string[]
  createSession(options: AgentSessionOptions, context: AgentSessionContext): Promise<AgentRuntimeSession>
  resumeSession(
    nativeSessionId: string,
    options: AgentSessionOptions,
    context: AgentSessionContext,
  ): Promise<AgentRuntimeSession>
  health(): Promise<AgentProviderHealth>
}

const PROVIDER_SYNONYMS: Readonly<Record<string, AgentProviderId>> = {
  codex: 'codex',
  'codex-agent': 'codex',
  claude: 'claude',
  'claude-agent': 'claude',
  agy: 'agy',
  'agy-agent': 'agy',
}

export function normalizeProviderId(value: unknown): AgentProviderId | undefined {
  return typeof value === 'string' ? PROVIDER_SYNONYMS[value] : undefined
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
}
