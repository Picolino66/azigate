import type { AppConfig } from '../config.js'
import type { CliProviderName } from '../broker/protocol.js'
import { ClientAbortedError } from '../upstream/errors.js'
import type { CliBrokerClientLike } from './broker-client.js'

export const CLI_ALIASES = {
  'codex-cli': 'codex',
  'claude-cli': 'claude',
} as const satisfies Record<string, CliProviderName>

export type CliAlias = keyof typeof CLI_ALIASES

export type ProviderSelection =
  | { kind: 'deepseek' }
  | { kind: 'cli'; alias: CliAlias; provider: CliProviderName; enabled: boolean }

export function resolveProvider(model: string, config: AppConfig): ProviderSelection {
  if (model === 'codex-cli') {
    return { kind: 'cli', alias: model, provider: 'codex', enabled: config.enableCodexCli }
  }
  if (model === 'claude-cli') {
    return { kind: 'cli', alias: model, provider: 'claude', enabled: config.enableClaudeCli }
  }
  return { kind: 'deepseek' }
}

export function enabledCliAliases(config: AppConfig): { alias: CliAlias; provider: CliProviderName }[] {
  return [
    ...(config.enableCodexCli ? [{ alias: 'codex-cli' as const, provider: 'codex' as const }] : []),
    ...(config.enableClaudeCli ? [{ alias: 'claude-cli' as const, provider: 'claude' as const }] : []),
  ]
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
