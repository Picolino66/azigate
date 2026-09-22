export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface RequestTelemetry extends TokenUsage {
  startedAt: number
  stream?: boolean
  model?: string
  effort?: string
  upstreamStatus?: number
  error?: string
  credentialId?: string
  freshInputTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  reasoningOutputTokens?: number
  estimatedCostUsd?: number
  cacheHitPercent?: number
  usageObserved?: boolean
  promptCacheKey?: string
  prefixFingerprint?: string
  requestBodyBytes?: number
  inputItemCount?: number
  toolCount?: number
  toolSchemaBytes?: number
  retryCount?: number
}

export interface ChatBody {
  model: string
  messages: unknown[]
  stream?: boolean
  [key: string]: unknown
}

declare module 'fastify' {
  interface FastifyRequest {
    telemetry: RequestTelemetry
    gatewayCredentialId?: string
  }
}
