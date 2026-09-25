import type { AgentProvider, AgentProviderHealth, AgentProviderId } from './agent-provider.js'
import { isCertified } from './versions.js'

export type VersionPolicy = 'warn' | 'fail-closed'

export interface ProviderStatus extends AgentProviderHealth {
  enabled: boolean
  certified: boolean
  available: boolean
  adapterVersion: string
  protocol: string
  remoteWorkspace: boolean
}

interface CachedStatus {
  status: ProviderStatus
  expiresAt: number
}

const HEALTH_TTL_MS = 60_000

/**
 * Registry fechado dos agent providers habilitados. Não existe fallback entre providers:
 * um provider indisponível recusa a sessão.
 */
export class AgentRegistry {
  private readonly cache = new Map<AgentProviderId, CachedStatus>()
  private readonly inflight = new Map<AgentProviderId, Promise<ProviderStatus>>()

  constructor(
    private readonly providers: ReadonlyMap<AgentProviderId, AgentProvider>,
    private readonly enabled: ReadonlySet<AgentProviderId>,
    private readonly policy: VersionPolicy,
    private readonly onUncertified: (provider: AgentProviderId, version: string | null) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: AgentProviderId): AgentProvider | undefined {
    return this.enabled.has(id) ? this.providers.get(id) : undefined
  }

  ids(): AgentProviderId[] {
    return [...this.providers.keys()]
  }

  async status(id: AgentProviderId): Promise<ProviderStatus | undefined> {
    const provider = this.providers.get(id)
    if (!provider) return undefined
    const base = {
      adapterVersion: provider.adapterVersion,
      protocol: provider.protocolVersion,
      remoteWorkspace: provider.supportsRemoteWorkspace,
    }
    if (!this.enabled.has(id)) {
      return {
        ...base,
        enabled: false,
        installed: false,
        authenticated: null,
        version: null,
        certified: false,
        available: false,
      }
    }
    const cached = this.cache.get(id)
    if (cached && cached.expiresAt > this.now()) return cached.status
    const running = this.inflight.get(id)
    if (running) return running
    const promise = provider
      .health()
      .catch((): AgentProviderHealth => ({ installed: false, authenticated: null, version: null }))
      .then((health) => {
        const certified = isCertified(id, health.version)
        if (health.installed && !certified) this.onUncertified(id, health.version)
        const status: ProviderStatus = {
          ...base,
          ...health,
          enabled: true,
          certified,
          available: health.installed && (certified || this.policy === 'warn'),
        }
        this.cache.set(id, { status, expiresAt: this.now() + HEALTH_TTL_MS })
        return status
      })
      .finally(() => this.inflight.delete(id))
    this.inflight.set(id, promise)
    return promise
  }

  async statusAll(): Promise<Record<AgentProviderId, ProviderStatus>> {
    const entries = await Promise.all(
      this.ids().map(async (id) => [id, await this.status(id)] as const),
    )
    const result = {} as Record<AgentProviderId, ProviderStatus>
    for (const [id, status] of entries) if (status) result[id] = status
    return result
  }
}
