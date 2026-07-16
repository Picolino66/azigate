import type { FastifyInstance, onRequestHookHandler } from 'fastify'
import type { ModelsService } from '../models/service.js'
import { createClientAbortSignal } from '../http/client-abort.js'

export function registerModelsRoute(
  app: FastifyInstance,
  protectedHook: onRequestHookHandler,
  models: ModelsService,
): void {
  app.get('/v1/models', { onRequest: protectedHook }, async (request, reply) => {
    const cancellation = createClientAbortSignal(request, reply)
    try {
      const result = await models.list(request.id, cancellation.signal)
      request.telemetry.upstreamStatus = result.status
      reply.headers(result.headers).code(result.status).send(result.body)
    } finally {
      cancellation.cleanup()
    }
  })
}
