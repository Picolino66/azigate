import type { AppConfig } from '../config.js'
import { CLI_ALIAS_CATALOG } from '../cli-catalog.js'
import type { CliAlias, CliModel, CliProviderName } from '../cli-catalog.js'
import { tokenFileExists } from './oauth/token-store.js'

export const CLI_ALIASES = CLI_ALIAS_CATALOG

export type ProviderSelection =
  | { kind: 'deepseek' }
  | { kind: 'cli'; alias: CliAlias; provider: CliProviderName; model: CliModel; enabled: boolean }

export function resolveProvider(model: string, config: AppConfig): ProviderSelection {
  const alias = CLI_ALIASES[model as CliAlias]
  if (alias) return {
    kind: 'cli',
    alias: model as CliAlias,
    provider: alias.provider,
    model: alias.model,
    enabled: alias.provider === 'codex' ? config.enableCodexCli : config.enableClaudeCli,
  }
  return { kind: 'deepseek' }
}

export function enabledCliAliases(config: AppConfig): { alias: CliAlias; provider: CliProviderName }[] {
  return (Object.entries(CLI_ALIASES) as [CliAlias, typeof CLI_ALIASES[CliAlias]][])
    .filter(([, alias]) => alias.provider === 'codex' ? config.enableCodexCli : config.enableClaudeCli)
    .map(([alias, value]) => ({ alias, provider: value.provider }))
}

export async function healthyCliAliases(config: AppConfig): Promise<{ alias: CliAlias; provider: CliProviderName }[]> {
  const enabled = enabledCliAliases(config)
  if (enabled.length === 0) return []
  const [codexReady, claudeReady] = await Promise.all([
    tokenFileExists(config.codexTokenFile),
    tokenFileExists(config.claudeTokenFile),
  ])
  return enabled.filter(({ provider }) => (provider === 'codex' ? codexReady : claudeReady))
}
