import type { FastifyInstance, onRequestHookHandler } from 'fastify'
import type { AgentRegistry } from '../../agents/core/agent-registry.js'
import type { SessionStore } from '../../agent-control/session-store.js'
import type { WorkerHub } from '../../agent-control/workers.js'

interface MetaDeps {
  agentAuth: onRequestHookHandler
  registry: AgentRegistry
  store: SessionStore
  workers?: WorkerHub
}

export function registerMetaRoutes(app: FastifyInstance, deps: MetaDeps): void {
  app.get('/health', async () => ({ status: 'ok', service: 'azigate-agentd' }))

  app.get('/ready', async (_request, reply) => {
    const statuses = await deps.registry.statusAll()
    const anyAvailable = Object.values(statuses).some((status) => status.available)
    if (!deps.store.healthy() || !anyAvailable) {
      return reply.code(503).send({ status: 'not_ready', service: 'azigate-agentd' })
    }
    return { status: 'ready', service: 'azigate-agentd' }
  })

  app.get('/agent/v1/providers', { onRequest: deps.agentAuth }, async () => deps.registry.statusAll())

  app.get('/agent/v1/workers', { onRequest: deps.agentAuth }, async () => ({ data: deps.workers?.list() ?? [] }))
}
