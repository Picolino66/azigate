import type { AppConfig } from '../config.js'
import type { CliProviderName, CodexCliModel } from '../broker/protocol.js'
import { ClientAbortedError } from '../upstream/errors.js'
import type { CliBrokerClientLike } from './broker-client.js'

export const CLI_ALIASES = {
  'codex-cli-sol': { provider: 'codex', model: 'gpt-5.6-sol' },
  'codex-cli-terra': { provider: 'codex', model: 'gpt-5.6-terra' },
  'codex-cli-luna': { provider: 'codex', model: 'gpt-5.6-luna' },
  'codex-cli-5.5': { provider: 'codex', model: 'gpt-5.5' },
  'codex-cli-5.4': { provider: 'codex', model: 'gpt-5.4' },
  'codex-cli': { provider: 'codex', model: 'gpt-5.4' },
  'claude-cli': { provider: 'claude' },
} as const satisfies Record<string, { provider: CliProviderName; model?: CodexCliModel }>

export type CliAlias = keyof typeof CLI_ALIASES

export type ProviderSelection =
  | { kind: 'deepseek' }
  | { kind: 'cli'; alias: CliAlias; provider: CliProviderName; model?: CodexCliModel; enabled: boolean }

export function resolveProvider(model: string, config: AppConfig): ProviderSelection {
  const alias = CLI_ALIASES[model as CliAlias]
  if (alias) return {
    kind: 'cli',
    alias: model as CliAlias,
    provider: alias.provider,
    ...('model' in alias ? { model: alias.model } : {}),
    enabled: alias.provider === 'codex' ? config.enableCodexCli : config.enableClaudeCli,
  }
  return { kind: 'deepseek' }
}

export function enabledCliAliases(config: AppConfig): { alias: CliAlias; provider: CliProviderName }[] {
  return (Object.entries(CLI_ALIASES) as [CliAlias, typeof CLI_ALIASES[CliAlias]][])
    .filter(([, alias]) => alias.provider === 'codex' ? config.enableCodexCli : config.enableClaudeCli)
    .map(([alias, value]) => ({ alias, provider: value.provider }))
}

export async function healthyCliAliases(
  config: AppConfig,
  broker: CliBrokerClientLike,
  signal?: AbortSignal,
): Promise<{ alias: CliAlias; provider: CliProviderName }[]> {
  const enabled = enabledCliAliases(config)
  if (enabled.length === 0) return []
  try {
    const health = await broker.health(signal)
    return enabled.filter(({ provider }) => health.providers[provider].available)
  } catch (error) {
    if (error instanceof ClientAbortedError) throw error
    return []
  }
}
