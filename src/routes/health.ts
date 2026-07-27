import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.js'
import { healthyCliAliases } from '../providers/registry.js'
import type { DeepSeekClient } from '../upstream/client.js'

async function deepSeekReady(config: AppConfig, client: DeepSeekClient): Promise<boolean> {
  if (!config.deepseekApiKey) return false
  if (!config.readyCheckUpstream) return true
  try {
    const exchange = await client.request({
      path: 'models',
      method: 'GET',
      requestId: randomUUID(),
      accept: 'application/json',
    })
    const ready = exchange.response.ok
    await exchange.response.body?.cancel()
    exchange.dispose()
    return ready
  } catch {
    return false
  }
}

export function registerHealthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  client: DeepSeekClient,
): void {
  app.get('/health', async () => ({ status: 'ok', service: 'azigate' }))

  app.get('/ready', async (_request, reply) => {
    if (config.gatewayApiKeys.length === 0) {
      return reply.code(503).send({ status: 'not_ready', service: 'azigate' })
    }
    const [deepseek, aliases] = await Promise.all([
      deepSeekReady(config, client),
      healthyCliAliases(config),
    ])
    if (!deepseek && aliases.length === 0) {
      return reply.code(503).send({ status: 'not_ready', service: 'azigate' })
    }
    return { status: 'ready', service: 'azigate' }
  })
}
