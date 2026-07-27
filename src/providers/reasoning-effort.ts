import {
  CLAUDE_MODEL_CATALOG,
  CLI_EFFORT_LEVELS,
  CODEX_MODEL_CATALOG,
  isClaudeCliModel,
  isCliEffortLevel,
  isCodexCliModel,
} from '../cli-catalog.js'
import type { CliEffortLevel, CliModel, CliProviderName } from '../cli-catalog.js'
import type { ChatBody } from '../types.js'

export class InvalidReasoningEffortError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidReasoningEffortError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requestedReasoningEffort(body: ChatBody): unknown {
  if (body.reasoning_effort !== undefined) return body.reasoning_effort
  if (body.reasoning === undefined || body.reasoning === false) return undefined
  if (!isRecord(body.reasoning)) {
    throw new InvalidReasoningEffortError('reasoning deve ser false ou um objeto')
  }
  return body.reasoning.effort
}

export function resolveCliEffort(
  body: ChatBody,
  provider: CliProviderName,
  model: CliModel,
): CliEffortLevel | undefined {
  const value = requestedReasoningEffort(body)
  if (value !== undefined && !isCliEffortLevel(value)) {
    throw new InvalidReasoningEffortError(`reasoning effort deve ser: ${CLI_EFFORT_LEVELS.join(', ')}`)
  }

  if (provider === 'codex') {
    if (!isCodexCliModel(model)) throw new InvalidReasoningEffortError('Modelo Codex interno inválido')
    const configuration = CODEX_MODEL_CATALOG[model]
    if (value === undefined) return configuration.defaultEffort
    if (value === 'max') return 'xhigh'
    return configuration.efforts.includes(value) ? value : configuration.defaultEffort
  }

  if (!isClaudeCliModel(model)) throw new InvalidReasoningEffortError('Modelo Claude interno inválido')
  const configuration = CLAUDE_MODEL_CATALOG[model]
  if (value === undefined) return configuration.defaultEffort
  return configuration.efforts.includes(value) ? value : configuration.defaultEffort
}
