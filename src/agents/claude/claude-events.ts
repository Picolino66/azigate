import {
  buildUsage,
  isRecord,
  nativeEvent,
  stringField,
  type AgentEventDraft,
} from '../core/agent-event.js'

/** Ferramentas do Claude Code que delegam a um subagente. */
const SUBAGENT_TOOLS = new Set(['Task', 'Agent'])

export type ClaudeLine =
  | { kind: 'events'; events: AgentEventDraft[] }
  | { kind: 'terminal'; events: AgentEventDraft[]; success: boolean; output?: string; native: unknown }
  | { kind: 'permission_request'; requestId: string; tool: string; input: unknown; native: unknown }
  | { kind: 'unsupported_control_request'; requestId: string }
  | { kind: 'control_cancel'; requestId: string }
  | { kind: 'control_response'; requestId: string; success: boolean }
  | { kind: 'ignored' }
  | { kind: 'invalid' }

/**
 * Traduz mensagens do `claude -p --output-format stream-json` para eventos universais,
 * preservando a mensagem original em `native`. Mantém estado por turno para não duplicar
 * texto (deltas parciais versus mensagem completa) e para nomear ferramentas concluídas.
 */
export class ClaudeEventMapper {
  private partialText = false
  private partialThinking = false
  private readonly toolNames = new Map<string, string>()
  private readonly subagentCalls = new Set<string>()

  resetTurn(): void {
    this.partialText = false
    this.partialThinking = false
    this.toolNames.clear()
    this.subagentCalls.clear()
  }

  map(message: unknown): ClaudeLine {
    if (!isRecord(message)) return { kind: 'invalid' }
    switch (message.type) {
      case 'system':
        return this.mapSystem(message)
      case 'stream_event':
        return this.mapStreamEvent(message)
      case 'assistant':
        return this.mapAssistant(message)
      case 'user':
        return this.mapUser(message)
      case 'result':
        return this.mapResult(message)
      case 'control_request':
        return this.mapControlRequest(message)
      case 'control_cancel_request': {
        const requestId = stringField(message, 'request_id')
        return requestId ? { kind: 'control_cancel', requestId } : { kind: 'invalid' }
      }
      case 'control_response':
        return this.mapControlResponse(message)
      case 'keep_alive':
        return { kind: 'ignored' }
      default:
        return { kind: 'events', events: [nativeEvent(message)] }
    }
  }

  private mapSystem(message: Record<string, unknown>): ClaudeLine {
    if (message.subtype !== 'init') return { kind: 'events', events: [nativeEvent(message)] }
    const nativeSessionId = stringField(message, 'session_id')
    const model = stringField(message, 'model')
    const event: AgentEventDraft = { event: 'session.started', native: message }
    if (nativeSessionId) event.nativeSessionId = nativeSessionId
    if (model) event.model = model
    return { kind: 'events', events: [event] }
  }

  private mapStreamEvent(message: Record<string, unknown>): ClaudeLine {
    const inner = message.event
    const topLevel = message.parent_tool_use_id === null || message.parent_tool_use_id === undefined
    if (!topLevel || !isRecord(inner) || inner.type !== 'content_block_delta' || !isRecord(inner.delta)) {
      return { kind: 'events', events: [nativeEvent(message)] }
    }
    const delta = inner.delta
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      this.partialText = true
      return { kind: 'events', events: [{ event: 'message.delta', text: delta.text, native: message }] }
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      this.partialThinking = true
      return { kind: 'events', events: [{ event: 'reasoning.delta', text: delta.thinking, native: message }] }
    }
    return { kind: 'events', events: [nativeEvent(message)] }
  }

  private mapAssistant(message: Record<string, unknown>): ClaudeLine {
    const topLevel = message.parent_tool_use_id === null || message.parent_tool_use_id === undefined
    const content = isRecord(message.message) ? message.message.content : undefined
    if (!topLevel || !Array.isArray(content)) return { kind: 'events', events: [nativeEvent(message)] }
    const events: AgentEventDraft[] = []
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'text' && typeof block.text === 'string' && !this.partialText) {
        events.push({ event: 'message.delta', text: block.text, native: message })
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && !this.partialThinking) {
        events.push({ event: 'reasoning.delta', text: block.thinking, native: message })
      } else if (block.type === 'tool_use') {
        const id = stringField(block, 'id')
        const name = stringField(block, 'name')
        if (!id || !name) continue
        this.toolNames.set(id, name)
        events.push({ event: 'tool.started', tool: name, toolCallId: id, native: message })
        if (SUBAGENT_TOOLS.has(name)) {
          this.subagentCalls.add(id)
          events.push({ event: 'subagent.started', toolCallId: id, native: message })
        }
      }
    }
    return { kind: 'events', events: events.length > 0 ? events : [nativeEvent(message)] }
  }

  private mapUser(message: Record<string, unknown>): ClaudeLine {
    const topLevel = message.parent_tool_use_id === null || message.parent_tool_use_id === undefined
    const content = isRecord(message.message) ? message.message.content : undefined
    if (!topLevel || !Array.isArray(content)) return { kind: 'events', events: [nativeEvent(message)] }
    const events: AgentEventDraft[] = []
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue
      const id = stringField(block, 'tool_use_id')
      if (!id) continue
      const status = block.is_error === true ? 'failed' : 'completed'
      events.push({ event: 'tool.completed', tool: this.toolNames.get(id) ?? 'unknown', toolCallId: id, status, native: message })
      if (this.subagentCalls.delete(id)) {
        events.push({ event: 'subagent.completed', toolCallId: id, status, native: message })
      }
    }
    return { kind: 'events', events: events.length > 0 ? events : [nativeEvent(message)] }
  }

  private mapResult(message: Record<string, unknown>): ClaudeLine {
    const usageRecord = isRecord(message.usage) ? message.usage : {}
    const input = numberOrZero(usageRecord.input_tokens)
    const cacheRead = numberOrZero(usageRecord.cache_read_input_tokens)
    const cacheCreation = numberOrZero(usageRecord.cache_creation_input_tokens)
    const output = usageRecord.output_tokens
    const promptTokens = input + cacheRead + cacheCreation
    const usage = buildUsage({
      inputTokens: isRecord(message.usage) ? promptTokens : undefined,
      outputTokens: output,
      cachedInputTokens: isRecord(message.usage) ? cacheRead : undefined,
      reasoningTokens: undefined,
      totalTokens: typeof output === 'number' ? promptTokens + output : undefined,
      costUsd: message.total_cost_usd,
    })
    const events: AgentEventDraft[] = usage ? [{ event: 'usage', usage, native: message }] : []
    const success = message.subtype === 'success' && message.is_error !== true
    const result = typeof message.result === 'string' ? message.result : undefined
    return result === undefined
      ? { kind: 'terminal', events, success, native: message }
      : { kind: 'terminal', events, success, output: result, native: message }
  }

  private mapControlRequest(message: Record<string, unknown>): ClaudeLine {
    const requestId = stringField(message, 'request_id')
    if (!requestId) return { kind: 'invalid' }
    const request = isRecord(message.request) ? message.request : {}
    if (request.subtype !== 'can_use_tool') return { kind: 'unsupported_control_request', requestId }
    const tool = stringField(request, 'tool_name') ?? 'unknown'
    return { kind: 'permission_request', requestId, tool, input: request.input, native: message }
  }

  private mapControlResponse(message: Record<string, unknown>): ClaudeLine {
    const response = isRecord(message.response) ? message.response : undefined
    const requestId = response ? stringField(response, 'request_id') : undefined
    if (!response || !requestId) return { kind: 'invalid' }
    return { kind: 'control_response', requestId, success: response.subtype === 'success' }
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

const SUMMARY_LIMIT = 500

/** Resumo legível para o aprovador, a partir do input da ferramenta. Truncado. */
export function summarizeToolInput(tool: string, input: unknown): string {
  let summary: string
  if (isRecord(input)) {
    const argv = Array.isArray(input.argv) ? input.argv.filter((item): item is string => typeof item === 'string') : undefined
    summary =
      stringField(input, 'command') ??
      (argv && argv.length > 0 ? argv.join(' ') : undefined) ??
      stringField(input, 'file_path') ??
      stringField(input, 'path') ??
      stringField(input, 'url') ??
      JSON.stringify(input)
  } else {
    summary = tool
  }
  return summary.length > SUMMARY_LIMIT ? `${summary.slice(0, SUMMARY_LIMIT - 1)}…` : summary
}
