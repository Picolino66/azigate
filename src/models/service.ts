import type { AppConfig } from '../config.js'
import { sanitizeText } from '../observability/sanitize.js'
import type { DeepSeekClient } from '../upstream/client.js'
import { UpstreamProtocolError, UpstreamTimeoutError } from '../upstream/errors.js'

export interface ModelsResult {
  status: number
  headers: Record<string, string>
  body: Buffer
}

interface CachedModels {
  expiresAt: number
  result: ModelsResult
}

export class ModelsService {
  private cache?: CachedModels

  constructor(
    private readonly config: AppConfig,
    private readonly client: DeepSeekClient,
  ) {}

  async list(requestId: string, signal?: AbortSignal): Promise<ModelsResult> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.result

    const exchange = await this.client.request({
      path: 'models',
      method: 'GET',
      requestId,
      accept: 'application/json',
      ...(signal ? { signal } : {}),
    })
    try {
      const raw = sanitizeText(
        Buffer.from(await exchange.response.arrayBuffer()).toString('utf8'),
        [this.config.deepseekApiKey, ...this.config.gatewayApiKeys],
      )
      const headers: Record<string, string> = {}
      for (const name of ['content-type', 'cache-control', 'retry-after', 'x-request-id']) {
        const value = exchange.response.headers.get(name)
        if (value) headers[name] = value
      }
      headers['x-request-id'] ??= requestId
      let body = Buffer.from(raw)

      if (exchange.response.ok) {
        let payload: unknown
        try {
          payload = JSON.parse(raw.trim())
        } catch {
          throw new UpstreamProtocolError()
        }
        if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) {
          throw new UpstreamProtocolError()
        }
        if (this.config.allowedModels.size > 0) {
          const record = payload as Record<string, unknown> & { data: unknown[] }
          body = Buffer.from(
            JSON.stringify({
              ...record,
              data: record.data.filter(
                (model) =>
                  model !== null &&
                  typeof model === 'object' &&
                  typeof (model as { id?: unknown }).id === 'string' &&
                  this.config.allowedModels.has((model as { id: string }).id),
              ),
            }),
          )
        }
      }

      const result = { status: exchange.response.status, headers, body }
      if (exchange.response.ok) this.cache = { expiresAt: Date.now() + this.config.modelsCacheTtlMs, result }
      return result
    } catch (error) {
      if (exchange.didTimeout()) throw new UpstreamTimeoutError()
      if (error instanceof UpstreamProtocolError) throw error
      throw new UpstreamProtocolError()
    } finally {
      exchange.dispose()
    }
  }
}
