import { createHash } from 'node:crypto'
import type { BrokerDecision, BrokerExecuteRequest, BrokerMessage } from './protocol.js'
import { canonicalSystemPrompt } from './prompt.js'

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  )
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

export function sessionKey(request: BrokerExecuteRequest): string {
  return hash({
    provider: request.provider,
    model: request.model,
    systemPrompt: canonicalSystemPrompt(request),
    ...(request.provider === 'claude' ? { effort: request.effort ?? null } : {}),
  })
}

export function transcriptHashes(messages: readonly BrokerMessage[]): string[] {
  const toolCallIds = new Map<string, string>()
  let nextToolCall = 0
  const normalized = messages.map((message) => {
    const toolCalls = message.toolCalls?.map((call) => {
      let normalizedId = toolCallIds.get(call.id)
      if (normalizedId === undefined) {
        normalizedId = `tool-call-${String(nextToolCall)}`
        nextToolCall += 1
        toolCallIds.set(call.id, normalizedId)
      }
      return { ...call, id: normalizedId }
    })
    const normalizedToolCallId = message.toolCallId === undefined
      ? undefined
      : toolCallIds.get(message.toolCallId) ?? 'tool-call-desconhecida'
    return {
      role: message.role,
      content: message.content,
      ...(normalizedToolCallId === undefined ? {} : { toolCallId: normalizedToolCallId }),
      ...(toolCalls === undefined ? {} : { toolCalls }),
    }
  })
  return normalized.map(hash)
}

export function hashesStartWith(candidate: readonly string[], prefix: readonly string[]): boolean {
  return candidate.length > prefix.length && prefix.every((value, index) => candidate[index] === value)
}

export function transcriptWithDecision(
  messages: readonly BrokerMessage[],
  decision: BrokerDecision,
): BrokerMessage[] {
  const assistant: BrokerMessage = {
    role: 'assistant',
    content: decision.content,
    ...(decision.toolCalls.length === 0
      ? {}
      : {
          toolCalls: decision.toolCalls.map((call, index) => ({
            id: `broker-generated-${String(index)}`,
            name: call.name,
            arguments: call.arguments,
          })),
        }),
  }
  return [...messages, assistant]
}
