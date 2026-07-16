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
    } finally {
      rmSync(directory, { recursive: true })
    }
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
