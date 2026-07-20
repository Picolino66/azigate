export const CODEX_CLI_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
] as const

export type CodexCliModel = typeof CODEX_CLI_MODELS[number]

export const CLI_EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type CliEffortLevel = typeof CLI_EFFORT_LEVELS[number]
export const CLAUDE_EFFORT_LEVELS = CLI_EFFORT_LEVELS
export type ClaudeEffortLevel = CliEffortLevel

interface CliModelConfiguration {
  efforts: readonly CliEffortLevel[]
  defaultEffort?: CliEffortLevel
}

const ALL_EFFORTS = CLI_EFFORT_LEVELS
const STANDARD_EFFORTS = ['low', 'medium', 'high', 'max'] as const
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const

export const CODEX_MODEL_CATALOG: Readonly<Record<CodexCliModel, CliModelConfiguration>> = {
  'gpt-5.6-sol': { efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
  'gpt-5.6-terra': { efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
  'gpt-5.6-luna': { efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
  'gpt-5.5': { efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
  'gpt-5.4': { efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
}

const CLAUDE_MODELS = {
  'claude-fable-5': { efforts: ALL_EFFORTS, defaultEffort: 'high' },
  'claude-sonnet-5': { efforts: ALL_EFFORTS, defaultEffort: 'high' },
  'claude-opus-4-8': { efforts: ALL_EFFORTS, defaultEffort: 'high' },
  'claude-opus-4-7': { efforts: ALL_EFFORTS, defaultEffort: 'xhigh' },
  'claude-opus-4-6': { efforts: STANDARD_EFFORTS, defaultEffort: 'high' },
  'claude-sonnet-4-6': { efforts: STANDARD_EFFORTS, defaultEffort: 'high' },
  'claude-sonnet-4-5': { efforts: [] },
  'claude-haiku-4-5': { efforts: [] },
} as const

export type ClaudeCliModel = keyof typeof CLAUDE_MODELS
export const CLAUDE_MODEL_CATALOG: Readonly<Record<ClaudeCliModel, CliModelConfiguration>> = CLAUDE_MODELS
export type CliModel = CodexCliModel | ClaudeCliModel
export type CliProviderName = 'codex' | 'claude'

export const CLI_ALIAS_CATALOG = {
  'codex-cli-sol': { provider: 'codex', model: 'gpt-5.6-sol' },
  'codex-cli-terra': { provider: 'codex', model: 'gpt-5.6-terra' },
  'codex-cli-luna': { provider: 'codex', model: 'gpt-5.6-luna' },
  'codex-cli-5.5': { provider: 'codex', model: 'gpt-5.5' },
  'codex-cli-5.4': { provider: 'codex', model: 'gpt-5.4' },
  'codex-cli': { provider: 'codex', model: 'gpt-5.4' },
  'claude-cli-fable-5': { provider: 'claude', model: 'claude-fable-5' },
  'claude-cli-sonnet-5': { provider: 'claude', model: 'claude-sonnet-5' },
  'claude-cli-opus-4.8': { provider: 'claude', model: 'claude-opus-4-8' },
  'claude-cli-opus-4.7': { provider: 'claude', model: 'claude-opus-4-7' },
  'claude-cli-opus-4.6': { provider: 'claude', model: 'claude-opus-4-6' },
  'claude-cli-sonnet-4.6': { provider: 'claude', model: 'claude-sonnet-4-6' },
  'claude-cli-sonnet-4.5': { provider: 'claude', model: 'claude-sonnet-4-5' },
  'claude-cli-haiku-4.5': { provider: 'claude', model: 'claude-haiku-4-5' },
  'claude-cli': { provider: 'claude', model: 'claude-sonnet-4-6' },
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
