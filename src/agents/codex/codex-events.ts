import {
  buildUsage,
  isRecord,
  nativeEvent,
  stringField,
  type AgentEventDraft,
} from '../core/agent-event.js'

/** Itens de thread que representam uso de ferramenta. */
const TOOL_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
  'imageGeneration',
  'imageView',
])

export type CodexNotification =
  | { kind: 'events'; events: AgentEventDraft[] }
  | { kind: 'turn_completed'; status: string; native: unknown }

function toolName(item: Record<string, unknown>): string {
  const type = stringField(item, 'type') ?? 'unknown'
  if (type === 'mcpToolCall') {
    const server = stringField(item, 'server')
    const tool = stringField(item, 'tool')
    return server && tool ? `mcp__${server}__${tool}` : type
  }
  if (type === 'dynamicToolCall') return stringField(item, 'tool') ?? type
  return type
}

function toolStatus(item: Record<string, unknown>): 'completed' | 'failed' | 'declined' {
  const status = stringField(item, 'status')
  if (status === 'failed') return 'failed'
  if (status === 'declined') return 'declined'
  return 'completed'
}

/**
 * Traduz notificações do `codex app-server` (protocolo v2) em eventos universais. Guarda o
 * texto da última mensagem do agente para preencher `turn.completed.output`.
 */
export class CodexEventMapper {
  private lastAgentMessage: string | undefined

  resetTurn(): void {
    this.lastAgentMessage = undefined
  }

  get output(): string | undefined {
    return this.lastAgentMessage
  }

  map(method: string, params: unknown, raw: Record<string, unknown>): CodexNotification {
    const record = isRecord(params) ? params : {}
    switch (method) {
      case 'item/agentMessage/delta': {
        const delta = stringField(record, 'delta')
        return { kind: 'events', events: [delta ? { event: 'message.delta', text: delta, native: raw } : nativeEvent(raw)] }
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const delta = stringField(record, 'delta')
        return { kind: 'events', events: [delta ? { event: 'reasoning.delta', text: delta, native: raw } : nativeEvent(raw)] }
      }
      case 'item/started':
        return { kind: 'events', events: this.mapItem(record, raw, 'started') }
      case 'item/completed':
        return { kind: 'events', events: this.mapItem(record, raw, 'completed') }
      case 'thread/tokenUsage/updated':
        return { kind: 'events', events: [this.mapUsage(record, raw)] }
      case 'turn/completed': {
        const turn = isRecord(record.turn) ? record.turn : {}
        return { kind: 'turn_completed', status: stringField(turn, 'status') ?? 'failed', native: raw }
      }
      default:
        return { kind: 'events', events: [nativeEvent(raw)] }
    }
  }

  private mapItem(
    params: Record<string, unknown>,
    raw: Record<string, unknown>,
    phase: 'started' | 'completed',
  ): AgentEventDraft[] {
    const item = isRecord(params.item) ? params.item : undefined
    const id = item ? stringField(item, 'id') : undefined
    if (!item || !id) return [nativeEvent(raw)]
    const type = stringField(item, 'type')
    if (type === 'agentMessage') {
      if (phase === 'completed' && typeof item.text === 'string') this.lastAgentMessage = item.text
      return [nativeEvent(raw)]
    }
    if (type === 'collabAgentToolCall') {
      return phase === 'started'
        ? [{ event: 'subagent.started', toolCallId: id, native: raw }]
        : [{ event: 'subagent.completed', toolCallId: id, status: toolStatus(item), native: raw }]
    }
    if (type && TOOL_ITEM_TYPES.has(type)) {
      const tool = toolName(item)
      return phase === 'started'
        ? [{ event: 'tool.started', tool, toolCallId: id, native: raw }]
        : [{ event: 'tool.completed', tool, toolCallId: id, status: toolStatus(item), native: raw }]
    }
    return [nativeEvent(raw)]
  }

  private mapUsage(params: Record<string, unknown>, raw: Record<string, unknown>): AgentEventDraft {
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : {}
    const last = isRecord(tokenUsage.last) ? tokenUsage.last : {}
    const usage = buildUsage({
      inputTokens: last.inputTokens,
      outputTokens: last.outputTokens,
      cachedInputTokens: last.cachedInputTokens,
      reasoningTokens: last.reasoningOutputTokens,
      totalTokens: last.totalTokens,
      costUsd: undefined,
    })
    return usage ? { event: 'usage', usage, native: raw } : nativeEvent(raw)
  }
}

const SUMMARY_LIMIT = 500

function truncate(value: string): string {
  return value.length > SUMMARY_LIMIT ? `${value.slice(0, SUMMARY_LIMIT - 1)}…` : value
}

export interface CodexApprovalRequest {
  tool: string
  summary: string
  respond(decision: 'allow' | 'deny'): unknown
}

/** Traduz um pedido de aprovação do servidor Codex; `undefined` para pedidos não suportados. */
export function codexApprovalRequest(method: string, params: unknown): CodexApprovalRequest | undefined {
  const record = isRecord(params) ? params : {}
  const reason = stringField(record, 'reason')
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return {
        tool: 'commandExecution',
        summary: truncate(stringField(record, 'command') ?? reason ?? 'executar comando'),
        respond: (decision) => ({ decision: decision === 'allow' ? 'accept' : 'decline' }),
      }
    case 'item/fileChange/requestApproval':
      return {
        tool: 'fileChange',
        summary: truncate(reason ?? 'alterar arquivos do workspace'),
        respond: (decision) => ({ decision: decision === 'allow' ? 'accept' : 'decline' }),
      }
    case 'item/permissions/requestApproval': {
      const requested = isRecord(record.permissions) ? record.permissions : {}
      const granted: Record<string, unknown> = {}
      if (requested.network !== null && requested.network !== undefined) granted.network = requested.network
      if (requested.fileSystem !== null && requested.fileSystem !== undefined) granted.fileSystem = requested.fileSystem
      return {
        tool: 'permissions',
        summary: truncate(reason ?? `permissões adicionais: ${Object.keys(granted).join(', ') || 'nenhuma'}`),
        respond: (decision) => ({ permissions: decision === 'allow' ? granted : {}, scope: 'turn' }),
      }
    }
    case 'execCommandApproval': {
      const command = Array.isArray(record.command)
        ? record.command.filter((part): part is string => typeof part === 'string').join(' ')
        : undefined
      return {
        tool: 'commandExecution',
        summary: truncate(command ?? reason ?? 'executar comando'),
        respond: (decision) => ({ decision: decision === 'allow' ? 'approved' : 'denied' }),
      }
    }
    case 'applyPatchApproval': {
      const files = isRecord(record.fileChanges) ? Object.keys(record.fileChanges) : []
      return {
        tool: 'fileChange',
        summary: truncate(files.length > 0 ? `alterar ${files.join(', ')}` : reason ?? 'aplicar patch'),
        respond: (decision) => ({ decision: decision === 'allow' ? 'approved' : 'denied' }),
      }
    }
    default:
      return undefined
  }
}
