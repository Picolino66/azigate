import { describe, expect, it } from 'vitest'
import { createTestConfig } from '../src/config.js'
import { CLAUDE_MODEL_CATALOG, CODEX_MODEL_CATALOG } from '../src/cli-catalog.js'
import { CLI_ALIASES, enabledCliAliases, healthyCliAliases, resolveProvider } from '../src/providers/registry.js'

describe('providers CLI', () => {
  it('reserva aliases Codex, fixa o modelo interno e não faz fallback DeepSeek', () => {
    expect(resolveProvider('codex-cli-luna', createTestConfig())).toEqual({
      kind: 'cli',
      alias: 'codex-cli-luna',
      provider: 'codex',
      model: 'gpt-5.6-luna',
      enabled: false,
    })
    expect(resolveProvider('codex-cli', createTestConfig())).toMatchObject({
      kind: 'cli',
      provider: 'codex',
      model: 'gpt-5.4',
      enabled: false,
    })
    expect(resolveProvider('deepseek-chat', createTestConfig())).toEqual({ kind: 'deepseek' })
  })

  it('publica todos os aliases Codex quando o provider está habilitado', () => {
    expect(enabledCliAliases(createTestConfig({ enableCodexCli: true }))).toEqual([
      { alias: 'codex-cli-sol', provider: 'codex' },
      { alias: 'codex-cli-terra', provider: 'codex' },
      { alias: 'codex-cli-luna', provider: 'codex' },
      { alias: 'codex-cli-5.5', provider: 'codex' },
      { alias: 'codex-cli-5.4', provider: 'codex' },
      { alias: 'codex-cli', provider: 'codex' },
    ])
  })

  it('reserva e publica os aliases Claude com modelos versionados', () => {
    expect(resolveProvider('claude-cli-opus-4.8', createTestConfig())).toMatchObject({
      kind: 'cli',
      provider: 'claude',
      model: 'claude-opus-4-8',
      enabled: false,
    })
    expect(resolveProvider('claude-cli', createTestConfig())).toMatchObject({
      kind: 'cli',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    })
    expect(enabledCliAliases(createTestConfig({ enableClaudeCli: true }))).toEqual([
      { alias: 'claude-cli-fable-5', provider: 'claude' },
      { alias: 'claude-cli-sonnet-5', provider: 'claude' },
      { alias: 'claude-cli-opus-4.8', provider: 'claude' },
      { alias: 'claude-cli-opus-4.7', provider: 'claude' },
      { alias: 'claude-cli-opus-4.6', provider: 'claude' },
      { alias: 'claude-cli-sonnet-4.6', provider: 'claude' },
      { alias: 'claude-cli-sonnet-4.5', provider: 'claude' },
      { alias: 'claude-cli-haiku-4.5', provider: 'claude' },
      { alias: 'claude-cli', provider: 'claude' },
    ])
  })

  it('mapeia os nove aliases Claude para modelos internos fixos', () => {
    expect(Object.fromEntries(
      Object.entries(CLI_ALIASES)
        .filter(([, configuration]) => configuration.provider === 'claude')
        .map(([alias, configuration]) => [alias, configuration.model]),
    )).toEqual({
      'claude-cli-fable-5': 'claude-fable-5',
      'claude-cli-sonnet-5': 'claude-sonnet-5',
      'claude-cli-opus-4.8': 'claude-opus-4-8',
      'claude-cli-opus-4.7': 'claude-opus-4-7',
      'claude-cli-opus-4.6': 'claude-opus-4-6',
      'claude-cli-sonnet-4.6': 'claude-sonnet-4-6',
      'claude-cli-sonnet-4.5': 'claude-sonnet-4-5',
      'claude-cli-haiku-4.5': 'claude-haiku-4-5',
      'claude-cli': 'claude-sonnet-4-6',
    })
  })

  it('catálogo Codex define defaults e efforts efetivos', () => {
    expect(CODEX_MODEL_CATALOG).toEqual({
      'gpt-5.6-sol': { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
      'gpt-5.6-terra': { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
      'gpt-5.6-luna': { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
      'gpt-5.5': { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
      'gpt-5.4': { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
    })
  })

  it('catálogo Claude define a matriz de effort esperada', () => {
    expect(CLAUDE_MODEL_CATALOG).toEqual({
      'claude-fable-5': { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
      'claude-sonnet-5': { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
      'claude-opus-4-8': { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
      'claude-opus-4-7': { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'xhigh' },
      'claude-opus-4-6': { efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'high' },
      'claude-sonnet-4-6': { efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'high' },
      'claude-sonnet-4-5': { efforts: [] },
      'claude-haiku-4-5': { efforts: [] },
    })
  })

  it('healthyCliAliases reflete presença do token OAuth por provedor', async () => {
    const config = createTestConfig({
      enableCodexCli: true,
      enableClaudeCli: true,
      codexTokenFile: '/tmp/azigate-inexistente-codex.json',
      claudeTokenFile: '/tmp/azigate-inexistente-claude.json',
    })
    expect(await healthyCliAliases(config)).toEqual([])
  })
})
