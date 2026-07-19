import type {
  ClaudeEffortLevel,
  CliModel,
  CliProviderName,
} from '../cli-catalog.js'

export {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_MODEL_CATALOG,
  CLI_ALIAS_CATALOG,
  CODEX_CLI_MODELS,
  isClaudeCliModel,
  isCodexCliModel,
} from '../cli-catalog.js'
export type {
  ClaudeCliModel,
  ClaudeEffortLevel,
  CliAlias,
  CliModel,
  CliProviderName,
  CodexCliModel,
} from '../cli-catalog.js'

export const BROKER_PROTOCOL_VERSION = 4 as const

export interface BrokerHistoricalToolCall {
  id: string
  name: string
  arguments: string
}

export interface BrokerMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content: string | null
  toolCallId?: string
  toolCalls?: BrokerHistoricalToolCall[]
}

export interface BrokerTool {
  name: string
  description?: string
  parameters: Record<string, unknown>
}

export type BrokerToolChoice = 'auto' | 'none' | 'required' | { name: string }

export interface BrokerExecuteRequest {
  version: typeof BROKER_PROTOCOL_VERSION
  requestId: string
  provider: CliProviderName
  model: CliModel
  effort?: ClaudeEffortLevel
  messages: BrokerMessage[]
  tools: BrokerTool[]
  toolChoice: BrokerToolChoice
  parallelToolCalls: boolean
}

export interface BrokerDecisionToolCall {
  name: string
  arguments: string
}

export interface BrokerDecision {
  content: string | null
  toolCalls: BrokerDecisionToolCall[]
}

export interface BrokerUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface BrokerExecuteResponse {
  version: typeof BROKER_PROTOCOL_VERSION
  requestId: string
  decision: BrokerDecision
  usage?: BrokerUsage
}

export interface BrokerProviderHealth {
  available: boolean
  code?: string
}

export interface BrokerHealthResponse {
  version: typeof BROKER_PROTOCOL_VERSION
  status: 'ready' | 'degraded'
  providers: Record<CliProviderName, BrokerProviderHealth>
}

export interface BrokerErrorResponse {
  version: typeof BROKER_PROTOCOL_VERSION
  error: {
    code: string
    message: string
  }
}
