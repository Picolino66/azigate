export const CODEX_CLI_MODELS = [
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
] as const

export type CodexCliModel = typeof CODEX_CLI_MODELS[number]

export const CLI_EFFORT_LEVELS = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type CliEffortLevel = typeof CLI_EFFORT_LEVELS[number]
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type ClaudeEffortLevel = CliEffortLevel

interface CliModelConfiguration {
  efforts: readonly CliEffortLevel[]
  defaultEffort?: CliEffortLevel
  // `false` quando a API rejeita `tool_choice` `any`/`tool` com 400 (ADR-021).
  forcedToolChoice?: boolean
}

const ALL_EFFORTS = CLAUDE_EFFORT_LEVELS
const CODEX_EFFORTS = CLI_EFFORT_LEVELS
const CODEX_NO_NONE = CLAUDE_EFFORT_LEVELS
const CODEX_NO_MAX = ['none', 'low', 'medium', 'high', 'xhigh'] as const

export const CODEX_MODEL_CATALOG: Readonly<Record<CodexCliModel, CliModelConfiguration>> = {
  'gpt-6-astra': { efforts: CODEX_NO_NONE, defaultEffort: 'medium' },
  'gpt-6.1-sol': { efforts: CODEX_NO_NONE, defaultEffort: 'medium' },
  'gpt-6.1-terra': { efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
  'gpt-6-sol': { efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
  'gpt-6-luna': { efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
  'gpt-5.6-sol': { efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
  'gpt-5.6-terra': { efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
  'gpt-5.6-luna': { efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
  'gpt-5.5': { efforts: CODEX_NO_MAX, defaultEffort: 'medium' },
  'gpt-5.4': { efforts: CODEX_NO_MAX, defaultEffort: 'medium' },
}

const CLAUDE_MODELS = {
  'claude-opus-5-5': { efforts: ALL_EFFORTS, defaultEffort: 'medium', forcedToolChoice: false },
  'claude-fable-5-1': { efforts: ALL_EFFORTS, defaultEffort: 'high', forcedToolChoice: false },
  'claude-sonnet-5': { efforts: ALL_EFFORTS, defaultEffort: 'high' },
  'claude-haiku-4-5': { efforts: [] },
} as const satisfies Record<string, CliModelConfiguration>

export type ClaudeCliModel = keyof typeof CLAUDE_MODELS
export const CLAUDE_MODEL_CATALOG: Readonly<Record<ClaudeCliModel, CliModelConfiguration>> = CLAUDE_MODELS
export type CliModel = CodexCliModel | ClaudeCliModel
export type CliProviderName = 'codex' | 'claude'

export const CLI_ALIAS_CATALOG = {
  'codex-cli-6-astra': { provider: 'codex', model: 'gpt-6-astra' },
  'codex-cli-6.1-sol': { provider: 'codex', model: 'gpt-6.1-sol' },
  'codex-cli-6.1-terra': { provider: 'codex', model: 'gpt-6.1-terra' },
  'codex-cli-6-sol': { provider: 'codex', model: 'gpt-6-sol' },
  'codex-cli-6-luna': { provider: 'codex', model: 'gpt-6-luna' },
  'codex-cli-sol': { provider: 'codex', model: 'gpt-5.6-sol' },
  'codex-cli-terra': { provider: 'codex', model: 'gpt-5.6-terra' },
  'codex-cli-luna': { provider: 'codex', model: 'gpt-5.6-luna' },
  'codex-cli-5.5': { provider: 'codex', model: 'gpt-5.5' },
  'codex-cli-5.4': { provider: 'codex', model: 'gpt-5.4' },
  'codex-cli': { provider: 'codex', model: 'gpt-5.4' },
  'claude-cli-opus-5.5': { provider: 'claude', model: 'claude-opus-5-5' },
  'claude-cli-fable-5.1': { provider: 'claude', model: 'claude-fable-5-1' },
  'claude-cli-sonnet-5': { provider: 'claude', model: 'claude-sonnet-5' },
  'claude-cli-haiku-4.5': { provider: 'claude', model: 'claude-haiku-4-5' },
  'claude-cli': { provider: 'claude', model: 'claude-opus-5-5' },
} as const satisfies Record<string, { provider: CliProviderName; model: CliModel }>

export type CliAlias = keyof typeof CLI_ALIAS_CATALOG

export function isCodexCliModel(value: unknown): value is CodexCliModel {
  return typeof value === 'string' && CODEX_CLI_MODELS.includes(value as CodexCliModel)
}

export function isClaudeCliModel(value: unknown): value is ClaudeCliModel {
  return typeof value === 'string' && value in CLAUDE_MODELS
}

export function isCliEffortLevel(value: unknown): value is CliEffortLevel {
  return typeof value === 'string' && CLI_EFFORT_LEVELS.includes(value as CliEffortLevel)
}

export function claudeAcceptsForcedToolChoice(model: ClaudeCliModel): boolean {
  const configuration: CliModelConfiguration = CLAUDE_MODEL_CATALOG[model]
  return configuration.forcedToolChoice !== false
}
