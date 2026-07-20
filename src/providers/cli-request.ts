import type {
  BrokerDecision,
  BrokerExecuteRequest,
  BrokerMessage,
  BrokerTool,
  BrokerToolChoice,
  CliEffortLevel,
  CliModel,
  CliProviderName,
} from '../broker/protocol.js'
import {
  BROKER_PROTOCOL_VERSION,
  CLAUDE_MODEL_CATALOG,
  CLI_EFFORT_LEVELS,
  CODEX_MODEL_CATALOG,
  isClaudeCliModel,
  isCliEffortLevel,
  isCodexCliModel,
} from '../broker/protocol.js'
import type { ChatBody } from '../types.js'
import { InvalidCliOutputError } from './errors.js'

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textContent(value: unknown, allowNull: boolean): string | null {
  if (typeof value === 'string') return value
  if (value === null && allowNull) return null
  if (!Array.isArray(value)) {
    throw new CliRequestValidationError('As mensagens CLI devem conter apenas texto', 'invalid_content_shape')
  }
  const parts = value.map((part) => {
    if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') {
      throw new CliRequestValidationError(
        'Conteúdo multimodal não é suportado por provedores CLI',
        'invalid_content_shape',
      )
    }
    return part.text
  })
  return parts.join('')
}

function validJsonObject(value: string): boolean {
  try {
    return isRecord(JSON.parse(value))
  } catch {
    return false
  }
}

function historicalToolCalls(value: unknown): BrokerMessage['toolCalls'] {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new CliRequestValidationError('tool_calls histórico deve ser um array não vazio', 'invalid_historical_tool_calls')
  }
  return value.map((call) => {
    if (
      !isRecord(call) ||
      typeof call.id !== 'string' ||
      call.id.length === 0 ||
      call.type !== 'function' ||
      !isRecord(call.function)
    ) {
      throw new CliRequestValidationError('tool_calls histórico contém uma chamada inválida', 'invalid_historical_tool_calls')
    }
    const name = call.function.name
    const args = call.function.arguments
    if (typeof name !== 'string' || !TOOL_NAME.test(name) || typeof args !== 'string' || !validJsonObject(args)) {
      throw new CliRequestValidationError('tool_calls histórico referencia ferramenta ou argumentos inválidos', 'invalid_historical_tool_calls')
    }
    return { id: call.id, name, arguments: args }
  })
}

function normalizeTools(value: unknown): BrokerTool[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new CliRequestValidationError('tools deve ser um array')
  const names = new Set<string>()
  return value.map((tool) => {
    if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) {
      throw new CliRequestValidationError('Provedores CLI aceitam somente function tools')
    }
    const { name, description, parameters } = tool.function
    if (typeof name !== 'string' || !TOOL_NAME.test(name) || names.has(name)) {
      throw new CliRequestValidationError('Nome de function tool inválido ou duplicado')
    }
    if (description !== undefined && typeof description !== 'string') {
      throw new CliRequestValidationError('Descrição de function tool inválida')
    }
    if (parameters !== undefined && !isRecord(parameters)) {
      throw new CliRequestValidationError('parameters deve ser um JSON Schema em objeto', 'invalid_tool_schema')
    }
    names.add(name)
    return {
      name,
      ...(description === undefined ? {} : { description }),
      parameters: parameters ?? {},
    }
  })
}

function normalizeToolChoice(value: unknown, offeredNames: ReadonlySet<string>): BrokerToolChoice {
  if (value === undefined) return 'auto'
  if (value === 'auto' || value === 'none' || value === 'required') return value
  if (
    isRecord(value) &&
    value.type === 'function' &&
    isRecord(value.function) &&
    typeof value.function.name === 'string' &&
    offeredNames.has(value.function.name)
  ) {
    return { name: value.function.name }
  }
  throw new CliRequestValidationError('tool_choice é inválido ou referencia uma ferramenta não oferecida')
}

function normalizeMessages(value: unknown): BrokerMessage[] {
  if (!Array.isArray(value)) throw new CliRequestValidationError('O campo messages deve ser um array')
  const historicalCallIds = new Set<string>()
  const completedCallIds = new Set<string>()
  return value.map((message) => {
    if (!isRecord(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(String(message.role))) {
      throw new CliRequestValidationError('A mensagem possui role inválida')
    }
    const role = message.role as BrokerMessage['role']
    const toolCalls = role === 'assistant' ? historicalToolCalls(message.tool_calls) : undefined
    if (toolCalls !== undefined) {
      for (const call of toolCalls) {
        if (historicalCallIds.has(call.id)) {
          throw new CliRequestValidationError('tool_calls histórico possui ID duplicado', 'invalid_historical_tool_calls')
        }
        historicalCallIds.add(call.id)
      }
    }
    const content = textContent(message.content, role === 'assistant' && toolCalls !== undefined)
    if (role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || message.tool_call_id === '') {
        throw new CliRequestValidationError('Mensagem tool exige tool_call_id', 'invalid_tool_result')
      }
      if (!historicalCallIds.has(message.tool_call_id) || completedCallIds.has(message.tool_call_id)) {
        throw new CliRequestValidationError(
          'Mensagem tool referencia uma chamada histórica inexistente ou já concluída',
          'invalid_tool_result',
        )
      }
      completedCallIds.add(message.tool_call_id)
      return { role, content, toolCallId: message.tool_call_id }
    }
    return { role, content, ...(toolCalls === undefined ? {} : { toolCalls }) }
  })
}

function requestedReasoningEffort(body: ChatBody): unknown {
  if (body.reasoning_effort !== undefined) return body.reasoning_effort
  if (body.reasoning === undefined || body.reasoning === false) return undefined
  if (!isRecord(body.reasoning)) {
    throw new CliRequestValidationError('reasoning para provedores CLI deve ser false ou um objeto')
  }
  return body.reasoning.effort
}

function normalizeReasoningEffort(
  value: unknown,
  provider: CliProviderName,
  model: CliModel,
): CliEffortLevel | undefined {
  if (!isCliEffortLevel(value) && value !== undefined) {
    throw new CliRequestValidationError(
      `reasoning effort para provedores CLI deve ser: ${CLI_EFFORT_LEVELS.join(', ')}`,
    )
  }

  if (provider === 'codex') {
    if (!isCodexCliModel(model)) throw new CliRequestValidationError('Modelo Codex interno inválido')
    const configuration = CODEX_MODEL_CATALOG[model]
    if (value === undefined) return configuration.defaultEffort
    if (value === 'max') return 'xhigh'
    return configuration.efforts.includes(value) ? value : configuration.defaultEffort
  }

  if (!isClaudeCliModel(model)) throw new CliRequestValidationError('Modelo Claude interno inválido')
  const configuration = CLAUDE_MODEL_CATALOG[model]
  if (value === undefined) return configuration.defaultEffort
  return configuration.efforts.includes(value) ? value : configuration.defaultEffort
}

export class CliRequestValidationError extends Error {
  constructor(
    public readonly publicMessage: string,
    public readonly reasonCode = 'invalid_cli_request',
  ) {
    super(publicMessage)
    this.name = 'CliRequestValidationError'
  }
}

export function normalizeCliRequest(
  body: ChatBody,
  requestId: string,
  provider: CliProviderName,
  model: CliModel,
): BrokerExecuteRequest {
  const tools = normalizeTools(body.tools)
  const effort = normalizeReasoningEffort(requestedReasoningEffort(body), provider, model)
  const offeredNames = new Set(tools.map((tool) => tool.name))
  const toolChoice = normalizeToolChoice(body.tool_choice, offeredNames)
  if (toolChoice !== 'none' && tools.length === 0 && body.tool_choice !== undefined) {
    throw new CliRequestValidationError('tool_choice exige ao menos uma function tool')
  }
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') {
    throw new CliRequestValidationError('parallel_tool_calls deve ser boolean')
  }
  return {
    version: BROKER_PROTOCOL_VERSION,
    requestId,
    provider,
    model,
    ...(effort === undefined ? {} : { effort }),
    messages: normalizeMessages(body.messages),
    tools,
    toolChoice,
    parallelToolCalls: body.parallel_tool_calls !== false,
  }
}

export function cliTranscriptBytes(request: Pick<BrokerExecuteRequest, 'messages' | 'tools'>): number {
  return Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools }))
}

export function validateCliDecision(decision: BrokerDecision, request: BrokerExecuteRequest): BrokerDecision {
  if (!isRecord(decision) || (typeof decision.content !== 'string' && decision.content !== null)) {
    throw new InvalidCliOutputError()
  }
  if (!Array.isArray(decision.toolCalls)) throw new InvalidCliOutputError()
  const offeredNames = new Set(request.tools.map((tool) => tool.name))
  const toolCalls = decision.toolCalls.map((call) => {
    if (!isRecord(call) || typeof call.name !== 'string' || typeof call.arguments !== 'string') {
      throw new InvalidCliOutputError()
    }
    if (!offeredNames.has(call.name) || !validJsonObject(call.arguments)) throw new InvalidCliOutputError()
    return { name: call.name, arguments: call.arguments }
  })
  if ((decision.content === null) === (toolCalls.length === 0)) throw new InvalidCliOutputError()
  if (request.toolChoice === 'none' && toolCalls.length > 0) throw new InvalidCliOutputError()
  if (request.toolChoice === 'required' && toolCalls.length === 0) throw new InvalidCliOutputError()
  if (typeof request.toolChoice === 'object') {
    const selectedName = request.toolChoice.name
    if (toolCalls.some((call) => call.name !== selectedName)) throw new InvalidCliOutputError()
  }
  if (!request.parallelToolCalls && toolCalls.length > 1) throw new InvalidCliOutputError()
  return { content: decision.content, toolCalls }
}
