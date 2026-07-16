export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface RequestTelemetry extends TokenUsage {
  startedAt: number
  stream?: boolean
  model?: string
  upstreamStatus?: number
  error?: string
  credentialId?: string
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
