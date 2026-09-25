import { randomUUID } from 'node:crypto'
import type { Server } from 'node:net'
import websocket from '@fastify/websocket'
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type onRequestHookHandler,
} from 'fastify'
import pino from 'pino'
import type { AgentProvider, AgentProviderId } from '../agents/core/agent-provider.js'
import { AgentRegistry } from '../agents/core/agent-registry.js'
import { AgyAgentProvider } from '../agents/agy/agy-provider.js'
import { ClaudeAgentProvider } from '../agents/claude/claude-provider.js'
import { CodexAgentProvider } from '../agents/codex/codex-provider.js'
import { AgentPlaneError, agentErrorBody } from '../agent-control/errors.js'
import { RemoteToolGateway } from '../agent-control/remote-tools.js'
import { SessionService, type McpBridgeLaunch } from '../agent-control/sessions.js'
import { SqliteSessionStore, type SessionStore } from '../agent-control/session-store.js'
import { WorkerHub } from '../agent-control/workers.js'
import { loadWorkspacesFile } from '../agent-control/workspaces.js'
import { safeError } from '../observability/sanitize.js'
import { GatewayAuthenticator } from '../security/auth.js'
import { FixedWindowRateLimiter } from '../security/rate-limiter.js'
import { WORKER_MAX_PAYLOAD_BYTES } from '../worker-protocol/protocol.js'
import { bearerToken, verifyWorkerToken, type WorkerIdentity } from '../worker-protocol/security.js'
import type { AgentdConfig } from './config.js'
import { defaultMcpBridgeLaunch } from './mcp-bridge-launch.js'
import { startMcpSocketServer } from './mcp-socket.js'
import { registerMetaRoutes } from './routes/meta.js'
import { registerNativeRoutes } from './routes/native.js'
import { registerSessionRoutes } from './routes/sessions.js'
import { registerWorkerRoute } from './routes/worker.js'

declare module 'fastify' {
  interface FastifyRequest {
    agentCredentialId?: string
    workerIdentity?: WorkerIdentity
    agentStartedAt?: number
  }
}

export interface AgentdDependencies {
  logger?: FastifyBaseLogger
  store?: SessionStore
  providers?: ReadonlyMap<AgentProviderId, AgentProvider>
  localWorkspaces?: ReadonlyMap<string, string>
  mcpBridge?: Omit<McpBridgeLaunch, 'socketPath'>
  startMcpSocket?: boolean
  now?: () => Date
}

export interface AgentdRuntime {
  app: FastifyInstance
  sessions: SessionService
  registry: AgentRegistry
  workers?: WorkerHub
}

function createLogger(config: AgentdConfig): FastifyBaseLogger {
  return pino({
    level: config.logLevel,
    base: { service: 'azigate-agentd' },
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

export function defaultProviders(config: AgentdConfig): Map<AgentProviderId, AgentProvider> {
  const inspectionCwd = config.dataDir
  return new Map<AgentProviderId, AgentProvider>([
    ['codex', new CodexAgentProvider({ binary: config.providers.codex.binary, inspectionCwd })],
    ['claude', new ClaudeAgentProvider({ binary: config.providers.claude.binary, inspectionCwd })],
    ['agy', new AgyAgentProvider({ binary: config.providers.agy.binary, inspectionCwd })],
  ])
}

/** Monta o `azigate-agentd` (ADR-022): Fastify, SessionService, registry, workers e socket MCP. */
export async function createAgentdApp(config: AgentdConfig, deps: AgentdDependencies = {}): Promise<AgentdRuntime> {
  const logger = deps.logger ?? createLogger(config)
  const diagnostic = (event: string, fields: Record<string, string | number | boolean> = {}): void => {
    logger.info({ event, ...fields })
  }
  const store = deps.store ?? (await SqliteSessionStore.open(config.databasePath))
  const providers = deps.providers ?? defaultProviders(config)
  const enabled = new Set(
    (Object.entries(config.providers) as [AgentProviderId, { enabled: boolean }][])
      .filter(([, provider]) => provider.enabled)
      .map(([id]) => id),
  )
  const registry = new AgentRegistry(providers, enabled, config.versionPolicy, (provider, version) => {
    logger.warn({ event: 'agent_provider_uncertified', provider, version: version ?? 'desconhecida', policy: config.versionPolicy })
  })
  const workers = config.worker.enabled
    ? new WorkerHub({ heartbeatIntervalMs: config.worker.heartbeatIntervalMs, registrationTimeoutMs: 10_000, diagnostic })
    : undefined
  const remoteTools = workers ? new RemoteToolGateway(workers) : undefined
  let mcpServer: Server | undefined
  if (remoteTools && deps.startMcpSocket !== false) {
    mcpServer = await startMcpSocketServer(config.mcpSocketPath, remoteTools)
  }
  const bridge = deps.mcpBridge ?? defaultMcpBridgeLaunch()
  const sessions = new SessionService({
    store,
    registry,
    localWorkspaces: deps.localWorkspaces ?? loadWorkspacesFile(config.workspacesFile),
    ...(workers ? { workers } : {}),
    ...(remoteTools ? { remoteTools, mcpBridge: { ...bridge, socketPath: config.mcpSocketPath } } : {}),
    dataDir: config.dataDir,
    limits: config.limits,
    diagnostic,
    ...(deps.now ? { now: deps.now } : {}),
  })
  const recovered = sessions.recoverOnStartup()
  if (recovered.suspended + recovered.failed > 0) diagnostic('agent_sessions_recovered', recovered)

  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: config.maxRequestBodyBytes,
    trustProxy: config.trustProxy,
    genReqId: () => randomUUID(),
  })
  await app.register(websocket, { options: { maxPayload: WORKER_MAX_PAYLOAD_BYTES } })

  const authenticator = new GatewayAuthenticator(config.apiKeys)
  const limiter = new FixedWindowRateLimiter(config.rateLimitWindowMs, config.rateLimitMax, config.rateLimitIpMax)

  app.addHook('onRequest', async (request) => {
    request.agentStartedAt = performance.now()
  })
  app.addHook('onSend', async (request, reply, payload) => {
    if (!reply.hasHeader('x-request-id')) reply.header('x-request-id', request.id)
    return payload
  })
  app.addHook('onResponse', async (request, reply) => {
    request.log.info({
      requestId: request.id,
      method: request.method,
      path: request.routeOptions.url ?? 'desconhecido',
      statusCode: reply.statusCode,
      durationMs: Math.round((performance.now() - (request.agentStartedAt ?? performance.now())) * 100) / 100,
      ...(request.agentCredentialId ? { credentialId: request.agentCredentialId } : {}),
      ...(request.workerIdentity ? { workerId: request.workerIdentity.workerId } : {}),
    })
  })

  const allowIp = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const ip = normalizeIp(request.ip)
    if (config.allowedIps.size > 0 && !config.allowedIps.has(ip)) {
      reply.code(403).send(agentErrorBody('O endereço IP não é permitido', 'ip_not_allowed'))
      return false
    }
    return true
  }

  const agentAuth: onRequestHookHandler = (request, reply, done): void => {
    const credentialId = authenticator.verify(request.headers.authorization)
    if (!credentialId) {
      reply.header('www-authenticate', 'Bearer')
      reply.code(401).send(agentErrorBody('Credencial do Agent Plane ausente ou inválida', 'invalid_agent_key'))
      return
    }
    request.agentCredentialId = credentialId
    if (!allowIp(request, reply)) return
    const rate = limiter.consume(credentialId, normalizeIp(request.ip))
    reply.header('x-ratelimit-limit', config.rateLimitMax).header('x-ratelimit-remaining', rate.remaining)
    if (!rate.allowed) {
      reply.header('retry-after', rate.retryAfterSeconds)
      reply.code(429).send(agentErrorBody('Limite local de requisições excedido', 'rate_limit_exceeded'))
      return
    }
    done()
  }

  const workerAuth: onRequestHookHandler = (request, reply, done): void => {
    const token = bearerToken(request.headers.authorization)
    const identity = token && config.worker.tokenSecret ? verifyWorkerToken(config.worker.tokenSecret, token) : undefined
    if (!identity) {
      reply.header('www-authenticate', 'Bearer')
      reply.code(401).send(agentErrorBody('Token de worker ausente ou inválido', 'invalid_worker_token'))
      return
    }
    request.workerIdentity = identity
    if (!allowIp(request, reply)) return
    done()
  }

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return
    if (error instanceof AgentPlaneError) {
      reply.code(error.statusCode).send(agentErrorBody(error.publicMessage, error.code))
      return
    }
    const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}
    if (record.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      reply.code(413).send(agentErrorBody('O corpo da requisição excede o limite configurado', 'request_body_too_large'))
      return
    }
    if (record.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || record.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      reply.code(400).send(agentErrorBody('O corpo precisa conter JSON válido', 'invalid_json'))
      return
    }
    if (record.statusCode === 415) {
      reply.code(415).send(agentErrorBody('Content-Type deve ser application/json', 'unsupported_media_type'))
      return
    }
    request.log.error({ event: 'agentd_unexpected_error', error: safeError(error) })
    reply.code(500).send(agentErrorBody('Ocorreu um erro interno inesperado', 'internal_error'))
  })
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send(agentErrorBody('Endpoint não encontrado', 'route_not_found'))
  })

  registerMetaRoutes(app, { agentAuth, registry, store, ...(workers ? { workers } : {}) })
  registerSessionRoutes(app, { agentAuth, sessions })
  registerNativeRoutes(app, { agentAuth, sessions })
  if (workers) registerWorkerRoute(app, { workerAuth, workers })

  app.addHook('onClose', async () => {
    await sessions.shutdown()
    workers?.closeAll()
    await new Promise<void>((resolve) => (mcpServer ? mcpServer.close(() => resolve()) : resolve()))
    store.close()
  })

  return { app, sessions, registry, ...(workers ? { workers } : {}) }
}
