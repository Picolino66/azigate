import { randomUUID } from 'node:crypto'
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type onRequestHookHandler,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { LogController } from 'fastify'
import pino from 'pino'
import type { AppConfig } from './config.js'
import './types.js'
import { publicError, registerErrorHandler } from './http/errors.js'
import { ModelsService } from './models/service.js'
import { GatewayMetrics } from './observability/metrics.js'
import { safeError } from './observability/sanitize.js'
import { registerChatRoute } from './routes/chat.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerModelsRoute } from './routes/models.js'
import { GatewayAuthenticator } from './security/auth.js'
import { FixedWindowRateLimiter } from './security/rate-limiter.js'
import { DeepSeekClient } from './upstream/client.js'

export interface AppDependencies {
  logger?: FastifyBaseLogger
  metrics?: GatewayMetrics
}

function createLogger(config: AppConfig): FastifyBaseLogger {
  return pino({
    level: config.logLevel,
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'authorization'],
      censor: '[SEGREDO_REMOVIDO]',
    },
  })
}

function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip
}

export function createApp(config: AppConfig, dependencies: AppDependencies = {}): FastifyInstance {
  const logger = dependencies.logger ?? createLogger(config)
  const app: FastifyInstance = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: config.maxRequestBodyBytes,
    trustProxy: config.trustProxy,
    genReqId: () => randomUUID(),
  })
  const metrics = dependencies.metrics ?? new GatewayMetrics()
  const authenticator = new GatewayAuthenticator(config.gatewayApiKeys)
  const limiter = new FixedWindowRateLimiter(config.rateLimitWindowMs, config.rateLimitMax, config.rateLimitIpMax)
  const client = new DeepSeekClient(config)
  const models = new ModelsService(config, client)

  app.decorateRequest('telemetry')
  app.addHook('onRequest', async (request) => {
    request.telemetry = { startedAt: performance.now() }
  })
  app.addHook('onSend', async (request, reply, payload) => {
    if (!reply.hasHeader('x-request-id')) reply.header('x-request-id', request.id)
    return payload
  })
  app.addHook('onResponse', async (request, reply) => {
    const durationMs = Math.round((performance.now() - request.telemetry.startedAt) * 100) / 100
    metrics.requestsTotal += 1
    metrics.observeDuration(durationMs)
    metrics.observeTokens(
      request.telemetry.inputTokens,
      request.telemetry.outputTokens,
      request.telemetry.totalTokens,
    )
    if ((request.telemetry.upstreamStatus ?? 0) >= 500) metrics.upstreamErrorsTotal += 1
    request.log.info({
      requestId: request.id,
      method: request.method,
      path: request.routeOptions.url ?? request.url,
      statusCode: reply.statusCode,
      durationMs,
      ...(request.telemetry.stream === undefined ? {} : { stream: request.telemetry.stream }),
      ...(request.telemetry.model === undefined ? {} : { model: request.telemetry.model }),
      ...(request.telemetry.upstreamStatus === undefined
        ? {}
        : { upstreamStatus: request.telemetry.upstreamStatus }),
      ...(request.telemetry.inputTokens === undefined ? {} : { inputTokens: request.telemetry.inputTokens }),
      ...(request.telemetry.outputTokens === undefined ? {} : { outputTokens: request.telemetry.outputTokens }),
      ...(request.telemetry.totalTokens === undefined ? {} : { totalTokens: request.telemetry.totalTokens }),
      ...(request.telemetry.error === undefined ? {} : { error: request.telemetry.error }),
    })
  })
  app.addHook('onError', async (request, _reply, error) => {
    request.telemetry.error = safeError(error)
  })

  const protectedHook: onRequestHookHandler = (
    request: FastifyRequest,
    reply: FastifyReply,
    done,
  ): void => {
    const credentialId = authenticator.verify(request.headers.authorization)
    if (!credentialId) {
      request.telemetry.error = 'InvalidGatewayKey'
      reply.header('www-authenticate', 'Bearer')
      reply.code(401).send(publicError('Credencial do gateway ausente ou inválida', 'invalid_gateway_key'))
      return
    }
    request.gatewayCredentialId = credentialId
    request.telemetry.credentialId = credentialId

    const ip = normalizeIp(request.ip)
    if (config.allowedIps.size > 0 && !config.allowedIps.has(ip)) {
      request.telemetry.error = 'IpNotAllowed'
      reply.code(403).send(publicError('O endereço IP não é permitido', 'ip_not_allowed'))
      return
    }

    const rateLimit = limiter.consume(credentialId, ip)
    reply.header('x-ratelimit-limit', config.rateLimitMax).header('x-ratelimit-remaining', rateLimit.remaining)
    if (!rateLimit.allowed) {
      metrics.rateLimitTotal += 1
      request.telemetry.error = 'RateLimitExceeded'
      reply.header('retry-after', rateLimit.retryAfterSeconds)
      reply.code(429).send(publicError('Limite local de requisições excedido', 'rate_limit_exceeded'))
      return
    }
    done()
  }

  registerErrorHandler(app)
  registerHealthRoutes(app, config, client)
  registerModelsRoute(app, protectedHook, models)
  registerChatRoute(app, config, protectedHook, client, metrics)

  app.setNotFoundHandler((request, reply) => {
    request.telemetry.error = 'RouteNotFound'
    reply.code(404).send(publicError('Endpoint não encontrado', 'route_not_found'))
  })
  app.addHook('onClose', async () => {
    await client.close()
  })

  return app
}
