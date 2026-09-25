import {
  buildUsage,
  isRecord,
  nativeEvent,
  stringField,
  type AgentEventDraft,
} from '../core/agent-event.js'

export type AgyLine =
  | { kind: 'init'; conversationId: string | undefined; events: AgentEventDraft[] }
  | { kind: 'events'; events: AgentEventDraft[] }
  | {
      kind: 'terminal'
      events: AgentEventDraft[]
      success: boolean
      output?: string
      native: unknown
    }
  | { kind: 'invalid' }

const FINISHED_STATUSES = new Set(['DONE', 'COMPLETED', 'COMPLETE', 'SUCCESS', 'SUCCEEDED', 'ERROR', 'FAILED', 'CANCELED', 'CANCELLED'])
const FAILED_STATUSES = new Set(['ERROR', 'FAILED', 'CANCELED', 'CANCELLED'])

function statusOf(record: Record<string, unknown>): string | undefined {
  const raw = stringField(record, 'status') ?? stringField(record, 'state')
  return raw?.toUpperCase().replace(/^.*_STATUS_/u, '')
}

/**
 * Traduz o NDJSON do `agy --output-format stream-json`. `init` e `result` foram verificados
 * na CLI 1.2.10; o formato interno de `step_update` (`step_type`, `tool_info`,
 * `subagent_info`) vem do changelog oficial e é mapeado de forma tolerante. Tudo o que não
 * for reconhecido segue como `provider.event`, com a mensagem original em `native`.
 */
export class AgyEventMapper {
  private readonly startedTools = new Set<string>()
  private readonly startedSubagents = new Set<string>()

  resetTurn(): void {
    this.startedTools.clear()
    this.startedSubagents.clear()
  }

  map(message: unknown): AgyLine {
    if (!isRecord(message)) return { kind: 'invalid' }
    const kind = message.event
    if (kind === 'init') return this.mapInit(message)
    if (kind === 'result') return this.mapResult(message)
    if (kind === 'step_update') return { kind: 'events', events: this.mapStep(message) }
    return { kind: 'events', events: [nativeEvent(message)] }
  }

  private mapInit(message: Record<string, unknown>): AgyLine {
    const conversationId = stringField(message, 'conversation_id')
    const event: AgentEventDraft = { event: 'session.started', native: message }
    if (conversationId) event.nativeSessionId = conversationId
    return { kind: 'init', conversationId, events: [event] }
  }

  private mapResult(message: Record<string, unknown>): AgyLine {
    const result = isRecord(message.result) ? message.result : {}
    const usageRecord = isRecord(result.usage) ? result.usage : {}
    const usage = buildUsage({
      inputTokens: usageRecord.input_tokens,
      outputTokens: usageRecord.output_tokens,
      cachedInputTokens: usageRecord.cache_read_tokens,
      reasoningTokens: usageRecord.thinking_tokens,
      totalTokens: usageRecord.total_tokens,
      costUsd: undefined,
    })
    const events: AgentEventDraft[] = usage ? [{ event: 'usage', usage, native: message }] : []
    const success = stringField(result, 'status')?.toUpperCase() === 'SUCCESS'
    const response = typeof result.response === 'string' ? result.response : undefined
    return response === undefined || response === ''
      ? { kind: 'terminal', events, success, native: message }
      : { kind: 'terminal', events, success, output: response, native: message }
  }

  private mapStep(message: Record<string, unknown>): AgentEventDraft[] {
    const payload = isRecord(message.step_update) ? message.step_update : message
    const events: AgentEventDraft[] = []
    const status = statusOf(payload)
    const finished = status !== undefined && FINISHED_STATUSES.has(status)
    const failed = status !== undefined && FAILED_STATUSES.has(status)
    const stepKey = stepIdentifier(payload)

    const textDelta = stringField(payload, 'text_delta') ?? stringField(payload, 'delta_text')
    if (textDelta) events.push({ event: 'message.delta', text: textDelta, native: message })
    const thinkingDelta = stringField(payload, 'thinking_delta') ?? stringField(payload, 'delta_thinking')
    if (thinkingDelta) events.push({ event: 'reasoning.delta', text: thinkingDelta, native: message })

    if (isRecord(payload.tool_info) && stepKey) {
      const info = payload.tool_info
      const tool =
        stringField(info, 'name') ??
        stringField(info, 'tool_name') ??
        stringField(info, 'canonical_name') ??
        stringField(payload, 'step_type') ??
        'unknown'
      if (!this.startedTools.has(stepKey)) {
        this.startedTools.add(stepKey)
        events.push({ event: 'tool.started', tool, toolCallId: stepKey, native: message })
      }
      if (finished) {
        this.startedTools.delete(stepKey)
        events.push({ event: 'tool.completed', tool, toolCallId: stepKey, status: failed ? 'failed' : 'completed', native: message })
      }
    }

    if (isRecord(payload.subagent_info) && stepKey) {
      const childConversation = stringField(payload.subagent_info, 'conversation_id')
      if (!this.startedSubagents.has(stepKey)) {
        this.startedSubagents.add(stepKey)
        const started: AgentEventDraft = { event: 'subagent.started', toolCallId: stepKey, native: message }
        if (childConversation) started.nativeSessionId = childConversation
        events.push(started)
      }
      if (finished) {
        this.startedSubagents.delete(stepKey)
        events.push({ event: 'subagent.completed', toolCallId: stepKey, status: failed ? 'failed' : 'completed', native: message })
      }
    }

    return events.length > 0 ? events : [nativeEvent(message)]
  }
}

function stepIdentifier(payload: Record<string, unknown>): string | undefined {
  for (const key of ['step_id', 'step_index', 'id']) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) return `step_${value}`
  }
  return undefined
}
