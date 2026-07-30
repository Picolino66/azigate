import type { AppConfig } from '../config.js'
import { sanitizeText } from '../observability/sanitize.js'
import { ProvidersUnavailableError } from '../providers/errors.js'
import { healthyCliAliases } from '../providers/registry.js'
import type { DeepSeekClient } from '../upstream/client.js'
import { ClientAbortedError, UpstreamProtocolError, UpstreamTimeoutError } from '../upstream/errors.js'

export interface ModelsResult {
  status: number
  headers: Record<string, string>
  body: Buffer
  upstreamStatus?: number
}

interface CachedDeepSeekModels {
  expiresAt: number
  payload: Record<string, unknown> & { data: unknown[] }
}

interface DeepSeekModelsResult {
  available: boolean
  payload?: Record<string, unknown> & { data: unknown[] }
  status?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export class ModelsService {
  private cache?: CachedDeepSeekModels

  constructor(
    private readonly config: AppConfig,
    private readonly client: DeepSeekClient,
  ) {}

  async list(requestId: string, signal?: AbortSignal): Promise<ModelsResult> {
    const [deepseek, aliases] = await Promise.all([
      this.listDeepSeek(requestId, signal),
      healthyCliAliases(this.config),
    ])
    if (!deepseek.available && aliases.length === 0) throw new ProvidersUnavailableError()

    const base = deepseek.payload ?? { object: 'list', data: [] }
    const cliModels = aliases.map(({ alias, provider }) => ({
      id: alias,
      object: 'model',
      created: 0,
      owned_by: `${provider}-cli`,
    }))
    const data = [...base.data, ...cliModels].filter((model) => {
      if (this.config.allowedModels.size === 0) return true
      return isRecord(model) && typeof model.id === 'string' && this.config.allowedModels.has(model.id)
    })
    return {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': requestId },
      body: Buffer.from(JSON.stringify({ ...base, object: 'list', data })),
      ...(deepseek.status === undefined ? {} : { upstreamStatus: deepseek.status }),
    }
  }

  private async listDeepSeek(requestId: string, signal?: AbortSignal): Promise<DeepSeekModelsResult> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return { available: true, payload: this.cache.payload, status: 200 }
    }

    let exchange
    try {
      exchange = await this.client.request({
        path: 'models',
        method: 'GET',
        requestId,
        accept: 'application/json',
        ...(signal ? { signal } : {}),
      })
      const status = exchange.response.status
      const raw = sanitizeText(
        Buffer.from(await exchange.response.arrayBuffer()).toString('utf8'),
        [this.config.deepseekApiKey, ...this.config.gatewayApiKeys],
      )
      if (!exchange.response.ok) return { available: false, status }
      let payload: unknown
      try {
        payload = JSON.parse(raw.trim())
      } catch {
        throw new UpstreamProtocolError()
      }
      if (!isRecord(payload) || !Array.isArray(payload.data)) throw new UpstreamProtocolError()
      const typedPayload = payload as Record<string, unknown> & { data: unknown[] }
      this.cache = { expiresAt: Date.now() + this.config.modelsCacheTtlMs, payload: typedPayload }
      return { available: true, payload: typedPayload, status }
    } catch (error) {
      if (error instanceof ClientAbortedError) throw error
      if (error instanceof UpstreamTimeoutError || error instanceof UpstreamProtocolError) return { available: false }
      return { available: false }
    } finally {
      exchange?.dispose()
    }
  }
}
