import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('configuração', () => {
  it('falha imediatamente sem os segredos obrigatórios', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/Variável obrigatória ausente/u)
  })

  it('lê segredos por arquivo e mantém o upstream padrão seguro', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gateway-config-'))
    const deepseekFile = join(directory, 'deepseek')
    const gatewayFile = join(directory, 'gateway')
    writeFileSync(deepseekFile, 'deepseek-file-secret\n')
    writeFileSync(gatewayFile, 'gateway-one,gateway-two\n')
    try {
      const config = loadConfig({
        NODE_ENV: 'production',
        DEEPSEEK_API_KEY_FILE: deepseekFile,
        GATEWAY_API_KEYS_FILE: gatewayFile,
      })
      expect(config.deepseekBaseUrl.href).toBe('https://api.deepseek.com/')
      expect(config.deepseekApiKey).toBe('deepseek-file-secret')
      expect(config.gatewayApiKeys).toEqual(['gateway-one', 'gateway-two'])
      expect(config.codexBaseUrl.href).toBe('https://chatgpt.com/backend-api/codex/')
      expect(config.codexTokenFile).toBe('secrets/codex-oauth.json')
      expect(config.claudeBaseUrl.href).toBe('https://api.anthropic.com/')
      expect(config.claudeTokenFile).toBe('secrets/claude-oauth.json')
    } finally {
      rmSync(directory, { recursive: true })
    }
  })

  it('aceita CODEX_BASE_URL/CLAUDE_BASE_URL e CODEX_TOKEN_FILE/CLAUDE_TOKEN_FILE customizados', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      DEEPSEEK_API_KEY: 'secret',
      GATEWAY_API_KEYS: 'gateway',
      CODEX_BASE_URL: 'https://codex.exemplo.com',
      CODEX_TOKEN_FILE: '/tmp/codex-oauth.json',
      CLAUDE_BASE_URL: 'https://claude.exemplo.com',
      CLAUDE_TOKEN_FILE: '/tmp/claude-oauth.json',
    })
    expect(config.codexBaseUrl.href).toBe('https://codex.exemplo.com/')
    expect(config.codexTokenFile).toBe('/tmp/codex-oauth.json')
    expect(config.claudeBaseUrl.href).toBe('https://claude.exemplo.com/')
    expect(config.claudeTokenFile).toBe('/tmp/claude-oauth.json')
  })

  it('rejeita CODEX_BASE_URL/CLAUDE_BASE_URL em HTTP fora de desenvolvimento', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DEEPSEEK_API_KEY: 'secret',
        GATEWAY_API_KEYS: 'gateway',
        CODEX_BASE_URL: 'http://codex.exemplo.com',
      }),
    ).toThrow(/CODEX_BASE_URL.*HTTPS/u)

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DEEPSEEK_API_KEY: 'secret',
        GATEWAY_API_KEYS: 'gateway',
        CLAUDE_BASE_URL: 'http://claude.exemplo.com',
      }),
    ).toThrow(/CLAUDE_BASE_URL.*HTTPS/u)
  })

  it('rejeita upstream HTTP em produção', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DEEPSEEK_API_KEY: 'secret',
        GATEWAY_API_KEYS: 'gateway',
        DEEPSEEK_BASE_URL: 'http://api.deepseek.com',
      }),
    ).toThrow(/HTTPS/u)
  })
})
