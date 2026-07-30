import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { OAuthNotLoggedInError, OAuthRefreshFailedError } from '../errors.js'

export interface StoredOAuthToken {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId?: string
  email?: string
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStoredOAuthToken(value: unknown): value is StoredOAuthToken {
  return (
    isRecord(value) &&
    typeof value.accessToken === 'string' &&
    typeof value.refreshToken === 'string' &&
    typeof value.expiresAt === 'number'
  )
}

export async function readTokenFile(filePath: string): Promise<StoredOAuthToken | undefined> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === 'ENOENT') return undefined
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  return isStoredOAuthToken(parsed) ? parsed : undefined
}

export async function writeTokenFile(filePath: string, token: StoredOAuthToken): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  await writeFile(filePath, JSON.stringify(token), { mode: 0o600 })
}

export async function tokenFileExists(filePath: string): Promise<boolean> {
  return (await readTokenFile(filePath)) !== undefined
}

export interface TokenManager {
  getAccessToken(): Promise<StoredOAuthToken>
}

export interface TokenManagerOptions {
  provider: string
  filePath: string
  refresh: (refreshToken: string) => Promise<StoredOAuthToken>
  refreshSkewMs?: number
}

export function createTokenManager(options: TokenManagerOptions): TokenManager {
  const skew = options.refreshSkewMs ?? 60_000
  let cached: StoredOAuthToken | undefined
  let inflightRefresh: Promise<StoredOAuthToken> | undefined

  async function load(): Promise<StoredOAuthToken> {
    if (cached) return cached
    const fromDisk = await readTokenFile(options.filePath)
    if (!fromDisk) throw new OAuthNotLoggedInError(options.provider)
    cached = fromDisk
    return cached
  }

  async function refreshAndPersist(current: StoredOAuthToken): Promise<StoredOAuthToken> {
    let refreshed: StoredOAuthToken
    try {
      refreshed = await options.refresh(current.refreshToken)
    } catch {
      throw new OAuthRefreshFailedError(options.provider)
    }
    await writeTokenFile(options.filePath, refreshed)
    cached = refreshed
    return refreshed
  }

  return {
    async getAccessToken(): Promise<StoredOAuthToken> {
      const token = await load()
      if (Date.now() < token.expiresAt - skew) return token
      if (!inflightRefresh) {
        inflightRefresh = refreshAndPersist(token).finally(() => {
          inflightRefresh = undefined
        })
      }
      return inflightRefresh
    },
  }
}
