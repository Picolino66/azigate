import type { FastifyInstance, onRequestHookHandler } from 'fastify'
import { normalizeProviderId } from '../../agents/core/agent-provider.js'
import type { AgentEvent } from '../../agents/core/agent-event.js'
import type { SessionService } from '../../agent-control/sessions.js'
import { CLOSE_CODES, sendJson } from '../../worker-protocol/transport.js'

interface NativeRouteDeps {
  agentAuth: onRequestHookHandler
  sessions: SessionService
}

const SESSION_NOT_FOUND = 4404

/**
 * `WS /native/:provider/:sessionId`: payloads nativos da sessão, somente de saída
 * (ADR-022, decisão 9). Mensagens do cliente nunca chegam à CLI.
 */
export function registerNativeRoutes(app: FastifyInstance, deps: NativeRouteDeps): void {
  app.get('/native/:provider/:sessionId', { websocket: true, onRequest: deps.agentAuth }, (socket, request) => {
    const params = request.params as { provider?: string; sessionId?: string }
    const owner = request.agentCredentialId ?? ''
    let log
    try {
      const session = deps.sessions.get(owner, params.sessionId ?? '')
      if (session.provider !== normalizeProviderId(params.provider)) throw new Error('provider divergente')
      log = deps.sessions.events(owner, session.id)
    } catch {
      socket.close(SESSION_NOT_FOUND, 'sessão não encontrada')
      return
    }
    const forward = (event: AgentEvent): void => {
      if (event.native !== undefined) sendJson(socket, { id: event.id, event: event.event, native: event.native })
    }
    let lastSent = 0
    for (const event of log.since(0)) {
      forward(event)
      lastSent = event.id
    }
    const unsubscribe = log.subscribe((event) => {
      if (event === null) {
        socket.close(CLOSE_CODES.normal, 'sessão encerrada')
        return
      }
      if (event.id <= lastSent) return
      lastSent = event.id
      forward(event)
    })
    socket.on('message', () => undefined)
    socket.on('close', unsubscribe)
    socket.on('error', unsubscribe)
  })
}
