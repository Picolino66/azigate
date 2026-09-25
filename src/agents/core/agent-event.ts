import type { AgentProviderId } from './agent-provider.js'

export const AGENT_EVENT_TYPES = [
  'session.started',
  'turn.started',
  'message.delta',
  'reasoning.delta',
  'tool.started',
  'tool.completed',
  'approval.required',
  'approval.resolved',
  'subagent.started',
  'subagent.completed',
  'usage',
  'turn.completed',
  'turn.failed',
  'session.closed',
  'provider.event',
] as const

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number]

export interface AgentUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  costUsd?: number
}

export type TurnFailureCode =
  | 'turn_cancelled'
  | 'turn_timeout'
  | 'agent_process_exited'
  | 'agent_protocol_error'
  | 'agent_turn_failed'
  | 'approval_lost'

export interface AgentEventFields {
  text?: string
  tool?: string
  toolCallId?: string
  status?: string
  approvalId?: string
  summary?: string
  decision?: 'allow' | 'deny'
  reason?: 'client' | 'timeout' | 'session_closed' | 'cancelled'
  nativeSessionId?: string
  model?: string
  output?: string
  usage?: AgentUsage
  error?: { code: TurnFailureCode; message: string }
  native?: unknown
}

/** Evento produzido por um provider, ainda sem numeração nem carimbo da sessão. */
export interface AgentEventDraft extends AgentEventFields {
  event: AgentEventType
}

/** Evento público: numerado por sessão, sempre com a mensagem nativa quando ela existe. */
export interface AgentEvent extends AgentEventFields {
  id: number
  event: AgentEventType
  sessionId: string
  provider: AgentProviderId
  turnId?: string
  timestamp: string
}

export function nativeEvent(native: unknown): AgentEventDraft {
  return { event: 'provider.event', native }
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Monta um usage somente com os campos numéricos válidos; devolve `undefined` se nenhum sobrar. */
export function buildUsage(fields: Record<keyof AgentUsage, unknown>): AgentUsage | undefined {
  const usage: AgentUsage = {}
  const input = finiteInteger(fields.inputTokens)
  const output = finiteInteger(fields.outputTokens)
  const cached = finiteInteger(fields.cachedInputTokens)
  const reasoning = finiteInteger(fields.reasoningTokens)
  const total = finiteInteger(fields.totalTokens)
  const cost = finiteNumber(fields.costUsd)
  if (input !== undefined) usage.inputTokens = input
  if (output !== undefined) usage.outputTokens = output
  if (cached !== undefined) usage.cachedInputTokens = cached
  if (reasoning !== undefined) usage.reasoningTokens = reasoning
  if (total !== undefined) usage.totalTokens = total
  if (cost !== undefined) usage.costUsd = cost
  return Object.keys(usage).length > 0 ? usage : undefined
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
