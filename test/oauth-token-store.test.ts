import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OAuthNotLoggedInError } from '../src/providers/errors.js'
import { createTokenManager, readTokenFile, writeTokenFile, type StoredOAuthToken } from '../src/providers/oauth/token-store.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'azigate-oauth-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function token(overrides: Partial<StoredOAuthToken> = {}): StoredOAuthToken {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  }
}

describe('oauth token-store', () => {
  it('retorna undefined quando o arquivo não existe', async () => {
    expect(await readTokenFile(join(dir, 'nao-existe.json'))).toBeUndefined()
  })

  it('grava e lê o token de volta, com diretório 0700 e arquivo 0600', async () => {
    const filePath = join(dir, 'sub', 'token.json')
    const original = token()
    await writeTokenFile(filePath, original)
    const read = await readTokenFile(filePath)
    expect(read).toEqual(original)

    const dirStat = await stat(join(dir, 'sub'))
    const fileStat = await stat(filePath)
    expect(dirStat.mode & 0o777).toBe(0o700)
    expect(fileStat.mode & 0o777).toBe(0o600)
  })

  describe('createTokenManager', () => {
    it('lança OAuthNotLoggedInError quando não há token salvo', async () => {
      const manager = createTokenManager({
        provider: 'codex',
        filePath: join(dir, 'token.json'),
        refresh: () => Promise.reject(new Error('não deveria ser chamado')),
      })
      await expect(manager.getAccessToken()).rejects.toBeInstanceOf(OAuthNotLoggedInError)
    })

    it('retorna o token do disco sem chamar refresh quando ainda é válido', async () => {
      const filePath = join(dir, 'token.json')
      await writeTokenFile(filePath, token())
      let refreshCalls = 0
      const manager = createTokenManager({
        provider: 'codex',
        filePath,
        refresh: () => {
          refreshCalls += 1
          return Promise.resolve(token({ accessToken: 'novo' }))
        },
      })
      const result = await manager.getAccessToken()
      expect(result.accessToken).toBe('access-1')
      expect(refreshCalls).toBe(0)
    })

    it('renova e persiste quando o token está perto de expirar', async () => {
      const filePath = join(dir, 'token.json')
      await writeTokenFile(filePath, token({ expiresAt: Date.now() + 1_000 }))
      const manager = createTokenManager({
        provider: 'codex',
        filePath,
        refresh: () => Promise.resolve(token({ accessToken: 'renovado', expiresAt: Date.now() + 3_600_000 })),
        refreshSkewMs: 60_000,
      })
      const result = await manager.getAccessToken()
      expect(result.accessToken).toBe('renovado')
      const persisted = await readTokenFile(filePath)
      expect(persisted?.accessToken).toBe('renovado')
    })

    it('deduplica renovações concorrentes em uma única chamada de refresh', async () => {
      const filePath = join(dir, 'token.json')
      await writeTokenFile(filePath, token({ expiresAt: Date.now() + 1_000 }))
      let refreshCalls = 0
      const manager = createTokenManager({
        provider: 'codex',
        filePath,
        refresh: async () => {
          refreshCalls += 1
          await new Promise((resolve) => setTimeout(resolve, 10))
          return token({ accessToken: 'renovado', expiresAt: Date.now() + 3_600_000 })
        },
      })
      const [a, b] = await Promise.all([manager.getAccessToken(), manager.getAccessToken()])
      expect(refreshCalls).toBe(1)
      expect(a.accessToken).toBe('renovado')
      expect(b.accessToken).toBe('renovado')
    })

    it('propaga OAuthRefreshFailedError quando o refresh falha', async () => {
      const filePath = join(dir, 'token.json')
      await writeTokenFile(filePath, token({ expiresAt: Date.now() + 1_000 }))
      const manager = createTokenManager({
        provider: 'claude',
        filePath,
        refresh: () => Promise.reject(new Error('token inválido')),
      })
      await expect(manager.getAccessToken()).rejects.toThrow('Falha ao renovar o token OAuth de claude')
    })
  })
})
