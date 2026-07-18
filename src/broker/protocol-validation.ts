import type { BrokerExecuteRequest, BrokerMessage, BrokerTool, BrokerToolChoice } from './protocol.js'
import { BROKER_PROTOCOL_VERSION, CLAUDE_EFFORT_LEVELS, CODEX_CLI_MODELS } from './protocol.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key))
}

function isJsonObject(value: string): boolean {
  try {
    return isRecord(JSON.parse(value))
  } catch {
    return false
  }
}

function isMessage(value: unknown): value is BrokerMessage {
  if (!isRecord(value) || !exactKeys(value, ['role', 'content', 'toolCallId', 'toolCalls'])) return false
  if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(String(value.role))) return false
  if (value.content !== null && typeof value.content !== 'string') return false
  if (value.toolCallId !== undefined && typeof value.toolCallId !== 'string') return false
  if (value.toolCalls !== undefined) {
    if (!Array.isArray(value.toolCalls) || value.toolCalls.length === 0) return false
    if (!value.toolCalls.every((call) =>
      isRecord(call) &&
      exactKeys(call, ['id', 'name', 'arguments']) &&
      typeof call.id === 'string' &&
      typeof call.name === 'string' &&
      typeof call.arguments === 'string' &&
      isJsonObject(call.arguments))) return false
  }
  if (value.role === 'tool') return typeof value.toolCallId === 'string' && value.toolCalls === undefined
  if (value.role === 'assistant') return value.toolCallId === undefined
  return value.toolCallId === undefined && value.toolCalls === undefined && typeof value.content === 'string'
}

function isTool(value: unknown): value is BrokerTool {
  return isRecord(value) &&
    exactKeys(value, ['name', 'description', 'parameters']) &&
    typeof value.name === 'string' &&
    (value.description === undefined || typeof value.description === 'string') &&
    isRecord(value.parameters)
}

function isToolChoice(value: unknown): value is BrokerToolChoice {
  return value === 'auto' || value === 'none' || value === 'required' || (
    isRecord(value) && exactKeys(value, ['name']) && typeof value.name === 'string'
  )
}

export function isBrokerExecuteRequest(value: unknown): value is BrokerExecuteRequest {
  if (!isRecord(value) || !exactKeys(value, [
    'version',
    'requestId',
    'provider',
    'model',
    'effort',
    'messages',
    'tools',
    'toolChoice',
    'parallelToolCalls',
  ])) return false
  return value.version === BROKER_PROTOCOL_VERSION &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    (value.provider === 'codex' || value.provider === 'claude') &&
    (value.provider === 'codex'
      ? typeof value.model === 'string' &&
        CODEX_CLI_MODELS.includes(value.model as typeof CODEX_CLI_MODELS[number]) &&
        value.effort === undefined
      : value.model === undefined && (
        value.effort === undefined ||
        typeof value.effort === 'string' &&
        CLAUDE_EFFORT_LEVELS.includes(value.effort as typeof CLAUDE_EFFORT_LEVELS[number])
      )) &&
    Array.isArray(value.messages) &&
    value.messages.every(isMessage) &&
    Array.isArray(value.tools) &&
    value.tools.every(isTool) &&
    isToolChoice(value.toolChoice) &&
    typeof value.parallelToolCalls === 'boolean'
}
