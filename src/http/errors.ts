import type { FastifyInstance } from 'fastify'
import { GatewayError } from '../upstream/errors.js'
import { safeError } from '../observability/sanitize.js'

function errorBody(message: string, code: string): object {
  return { error: { message, type: 'gateway_error', code } }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    request.telemetry.error = safeError(error)
    if (reply.sent) return

    if (error instanceof GatewayError) {
      if (error.retryAfterSeconds !== undefined) reply.header('retry-after', error.retryAfterSeconds)
      reply.code(error.statusCode).send(errorBody(error.publicMessage, error.code))
      return
    }
    const errorRecord = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
    if (errorRecord.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      reply.code(413).send(errorBody('O corpo da requisição excede o limite configurado', 'request_body_too_large'))
      return
    }
    if (errorRecord.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      reply.code(400).send(errorBody('O corpo precisa conter JSON válido', 'invalid_json'))
      return
    }
    const status = errorRecord.statusCode
    if (status === 415) {
      reply.code(415).send(errorBody('Content-Type deve ser application/json', 'unsupported_media_type'))
      return
    }
    reply.code(500).send(errorBody('Ocorreu um erro interno inesperado', 'internal_error'))
  })
}

export function publicError(message: string, code: string): object {
  return errorBody(message, code)
}
