import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.js'
import type { DeepSeekClient } from '../upstream/client.js'

export function registerHealthRoutes(app: FastifyInstance, config: AppConfig, client: DeepSeekClient): void {
  app.get('/health', async () => ({ status: 'ok', service: 'deepseek-gateway' }))

  app.get('/ready', async (_request, reply) => {
    if (!config.deepseekApiKey || config.gatewayApiKeys.length === 0) {
      return reply.code(503).send({ status: 'not_ready', service: 'deepseek-gateway' })
    }
    if (config.readyCheckUpstream) {
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
        if (!ready) return reply.code(503).send({ status: 'not_ready', service: 'deepseek-gateway' })
      } catch {
        return reply.code(503).send({ status: 'not_ready', service: 'deepseek-gateway' })
      }
    }
    return { status: 'ready', service: 'deepseek-gateway' }
  })
}
