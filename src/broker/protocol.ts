export const BROKER_PROTOCOL_VERSION = 3 as const

export type CliProviderName = 'codex' | 'claude'

export const CODEX_CLI_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
] as const

export type CodexCliModel = typeof CODEX_CLI_MODELS[number]

export const CLAUDE_EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ClaudeEffortLevel = typeof CLAUDE_EFFORT_LEVELS[number]

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
  model?: CodexCliModel
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
