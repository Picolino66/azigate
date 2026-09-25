import type { FastifyInstance, onRequestHookHandler } from 'fastify'
import type { WorkerHub } from '../../agent-control/workers.js'

interface WorkerRouteDeps {
  workerAuth: onRequestHookHandler
  workers: WorkerHub
}

/** `WS /worker/v1/connect`: o token do worker é validado antes do upgrade (ADR-023). */
export function registerWorkerRoute(app: FastifyInstance, deps: WorkerRouteDeps): void {
  app.get('/worker/v1/connect', { websocket: true, onRequest: deps.workerAuth }, (socket, request) => {
    const identity = request.workerIdentity
    if (!identity) {
      socket.close(4401, 'token ausente')
      return
    }
    deps.workers.attach(socket, identity)
  })
}
