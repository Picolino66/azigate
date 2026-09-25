import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify'
import type { AgentEvent } from '../../agents/core/agent-event.js'
import { AgentPlaneError } from '../../agent-control/errors.js'
import type { SessionService } from '../../agent-control/sessions.js'

interface SessionRouteDeps {
  agentAuth: onRequestHookHandler
  sessions: SessionService
}

interface IdParams {
  id: string
}

const KEEP_ALIVE_MS = 15_000

function owner(request: FastifyRequest): string {
  const credential = request.agentCredentialId
  if (!credential) throw new AgentPlaneError(401, 'invalid_agent_key', 'Credencial do Agent Plane ausente ou inválida')
  return credential
}

function sessionId(request: FastifyRequest): string {
  const id = (request.params as Partial<IdParams>).id
  if (typeof id !== 'string' || id.length > 64) throw new AgentPlaneError(404, 'session_not_found', 'Sessão não encontrada')
  return id
}

/** Último evento já recebido pelo cliente: `Last-Event-ID` tem precedência sobre `?after=`. */
export function parseAfter(header: unknown, query: unknown): number {
  const candidates = [header, typeof query === 'object' && query !== null ? (query as Record<string, unknown>).after : undefined]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    const value = Number(candidate)
    if (Number.isSafeInteger(value) && value >= 0) return value
    throw new AgentPlaneError(400, 'invalid_request', 'Cursor de eventos inválido')
  }
  return 0
}

function writeEvent(reply: FastifyReply, event: AgentEvent): void {
  reply.raw.write(`id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`)
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  const { agentAuth, sessions } = deps

  app.post('/agent/v1/sessions', { onRequest: agentAuth }, async (request, reply) => {
    const view = await sessions.create(owner(request), request.body)
    return reply.code(201).send(view)
  })

  app.get('/agent/v1/sessions/:id', { onRequest: agentAuth }, async (request) =>
    sessions.get(owner(request), sessionId(request)),
  )

  app.delete('/agent/v1/sessions/:id', { onRequest: agentAuth }, async (request) =>
    sessions.close(owner(request), sessionId(request)),
  )

  app.post('/agent/v1/sessions/:id/turns', { onRequest: agentAuth }, async (request, reply) => {
    const accepted = await sessions.startTurn(owner(request), sessionId(request), request.body)
    return reply.code(202).send(accepted)
  })

  app.post('/agent/v1/sessions/:id/cancel', { onRequest: agentAuth }, async (request, reply) => {
    const result = sessions.cancel(owner(request), sessionId(request))
    return reply.code(202).send(result)
  })

  app.post('/agent/v1/approvals/:id', { onRequest: agentAuth }, async (request) => {
    const id = (request.params as Partial<IdParams>).id ?? ''
    return sessions.decideApproval(owner(request), id, request.body)
  })

  app.get('/agent/v1/sessions/:id/events', { onRequest: agentAuth }, (request, reply) => {
    const log = sessions.events(owner(request), sessionId(request))
    const after = parseAfter(request.headers['last-event-id'], request.query)
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': request.id,
    })
    // Descarrega os cabeçalhos já: sem eventos no buffer, o Node não enviaria nada.
    reply.raw.write(': conectado\n\n')
    let lastSent = after
    for (const event of log.since(after)) {
      writeEvent(reply, event)
      lastSent = event.id
    }
    if (log.isClosed) {
      reply.raw.end()
      return
    }
    let finished = false
    const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), KEEP_ALIVE_MS)
    keepAlive.unref()
    const finish = (): void => {
      if (finished) return
      finished = true
      clearInterval(keepAlive)
      unsubscribe()
      if (!reply.raw.writableEnded) reply.raw.end()
    }
    const unsubscribe = log.subscribe((event) => {
      if (event === null) {
        finish()
        return
      }
      if (event.id <= lastSent) return
      writeEvent(reply, event)
      lastSent = event.id
    })
    request.raw.on('close', finish)
  })
}
