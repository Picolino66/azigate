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
import { createColorizedStdoutDestination } from './observability/log-colors.js'
import { safeError } from './observability/sanitize.js'
import { registerChatRoute } from './routes/chat.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerModelsRoute } from './routes/models.js'
import { GatewayAuthenticator } from './security/auth.js'
import { FixedWindowRateLimiter } from './security/rate-limiter.js'
import { DeepSeekClient } from './upstream/client.js'
import { AnthropicClient } from './providers/anthropic-client.js'
import { CodexClient } from './providers/codex-client.js'
import { refreshClaudeToken } from './providers/oauth/claude-oauth.js'
import { refreshCodexToken } from './providers/oauth/codex-oauth.js'
import { createTokenManager, type TokenManager } from './providers/oauth/token-store.js'

export interface AppDependencies {
  logger?: FastifyBaseLogger
  metrics?: GatewayMetrics
  codexTokenManager?: TokenManager
  claudeTokenManager?: TokenManager
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
  }, createColorizedStdoutDestination())
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
  const codexTokens =
    dependencies.codexTokenManager ??
    createTokenManager({ provider: 'codex', filePath: config.codexTokenFile, refresh: refreshCodexToken })
  const claudeTokens =
    dependencies.claudeTokenManager ??
    createTokenManager({ provider: 'claude', filePath: config.claudeTokenFile, refresh: refreshClaudeToken })
  const codexClient = new CodexClient(
    {
      baseUrl: config.codexBaseUrl.href,
      connectTimeoutMs: config.connectTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      maxRetries: config.upstreamMaxRetries,
      retryMaxDelayMs: config.retryMaxDelayMs,
    },
    codexTokens,
  )
  const anthropicClient = new AnthropicClient(
    {
      baseUrl: config.claudeBaseUrl.href,
      connectTimeoutMs: config.connectTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      maxRetries: config.upstreamMaxRetries,
      retryMaxDelayMs: config.retryMaxDelayMs,
    },
    claudeTokens,
  )
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
      {
        ...(request.telemetry.freshInputTokens === undefined
          ? {}
          : { freshInput: request.telemetry.freshInputTokens }),
        ...(request.telemetry.cachedInputTokens === undefined
          ? {}
          : { cachedInput: request.telemetry.cachedInputTokens }),
        ...(request.telemetry.cacheCreationInputTokens === undefined
          ? {}
          : { cacheCreationInput: request.telemetry.cacheCreationInputTokens }),
        ...(request.telemetry.cacheReadInputTokens === undefined
          ? {}
          : { cacheReadInput: request.telemetry.cacheReadInputTokens }),
        ...(request.telemetry.reasoningOutputTokens === undefined
          ? {}
          : { reasoningOutput: request.telemetry.reasoningOutputTokens }),
        ...(request.telemetry.estimatedCostUsd === undefined
          ? {}
          : { estimatedCostUsd: request.telemetry.estimatedCostUsd }),
      },
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
      ...(request.telemetry.effort === undefined ? {} : { effort: request.telemetry.effort }),
      ...(request.telemetry.upstreamStatus === undefined
        ? {}
        : { upstreamStatus: request.telemetry.upstreamStatus }),
      ...(request.telemetry.inputTokens === undefined ? {} : { inputTokens: request.telemetry.inputTokens }),
      ...(request.telemetry.outputTokens === undefined ? {} : { outputTokens: request.telemetry.outputTokens }),
      ...(request.telemetry.totalTokens === undefined ? {} : { totalTokens: request.telemetry.totalTokens }),
      ...(request.telemetry.freshInputTokens === undefined
        ? {}
        : { freshInputTokens: request.telemetry.freshInputTokens }),
      ...(request.telemetry.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: request.telemetry.cachedInputTokens }),
      ...(request.telemetry.cacheCreationInputTokens === undefined
        ? {}
        : { cacheCreationInputTokens: request.telemetry.cacheCreationInputTokens }),
      ...(request.telemetry.cacheReadInputTokens === undefined
        ? {}
        : { cacheReadInputTokens: request.telemetry.cacheReadInputTokens }),
      ...(request.telemetry.reasoningOutputTokens === undefined
        ? {}
        : { reasoningOutputTokens: request.telemetry.reasoningOutputTokens }),
      ...(request.telemetry.estimatedCostUsd === undefined
        ? {}
        : { estimatedCostUsd: request.telemetry.estimatedCostUsd }),
      ...(request.telemetry.cacheHitPercent === undefined
        ? {}
        : { cacheHitPercent: request.telemetry.cacheHitPercent }),
      ...(request.telemetry.usageObserved === undefined
        ? {}
        : { usageObserved: request.telemetry.usageObserved }),
      ...(request.telemetry.promptCacheKey === undefined
        ? {}
        : { promptCacheKey: request.telemetry.promptCacheKey }),
      ...(request.telemetry.prefixFingerprint === undefined
        ? {}
        : { prefixFingerprint: request.telemetry.prefixFingerprint }),
      ...(request.telemetry.requestBodyBytes === undefined
        ? {}
        : { requestBodyBytes: request.telemetry.requestBodyBytes }),
      ...(request.telemetry.inputItemCount === undefined
        ? {}
        : { inputItemCount: request.telemetry.inputItemCount }),
      ...(request.telemetry.toolCount === undefined ? {} : { toolCount: request.telemetry.toolCount }),
      ...(request.telemetry.toolSchemaBytes === undefined
        ? {}
        : { toolSchemaBytes: request.telemetry.toolSchemaBytes }),
      ...(request.telemetry.retryCount === undefined ? {} : { retryCount: request.telemetry.retryCount }),
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
  registerChatRoute(app, config, protectedHook, client, codexClient, anthropicClient, metrics)

  app.setNotFoundHandler((request, reply) => {
    request.telemetry.error = 'RouteNotFound'
    reply.code(404).send(publicError('Endpoint não encontrado', 'route_not_found'))
  })
  app.addHook('onClose', async () => {
    await Promise.all([client.close(), codexClient.close(), anthropicClient.close()])
  })

  return app
}
