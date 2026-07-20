export class GatewayMetrics {
  requestsTotal = 0
  upstreamErrorsTotal = 0
  rateLimitTotal = 0
  activeStreams = 0
  inputTokensTotal = 0
  outputTokensTotal = 0
  totalTokens = 0
  freshInputTokensTotal = 0
  cachedInputTokensTotal = 0
  cacheCreationInputTokensTotal = 0
  cacheReadInputTokensTotal = 0
  reasoningOutputTokensTotal = 0
  estimatedCostUsdTotal = 0
  memorySessionRequestsTotal = 0
  reusedSessionRequestsTotal = 0
  transcriptBytesTotal = 0
  requestDurationMsTotal = 0

  observeDuration(durationMs: number): void {
    this.requestDurationMsTotal += durationMs
  }

  observeTokens(
    input?: number,
    output?: number,
    total?: number,
    details: {
      freshInput?: number
      cachedInput?: number
      cacheCreationInput?: number
      cacheReadInput?: number
      reasoningOutput?: number
      estimatedCostUsd?: number
    } = {},
  ): void {
    this.inputTokensTotal += input ?? 0
    this.outputTokensTotal += output ?? 0
    this.totalTokens += total ?? 0
    this.freshInputTokensTotal += details.freshInput ?? 0
    this.cachedInputTokensTotal += details.cachedInput ?? 0
    this.cacheCreationInputTokensTotal += details.cacheCreationInput ?? 0
    this.cacheReadInputTokensTotal += details.cacheReadInput ?? 0
    this.reasoningOutputTokensTotal += details.reasoningOutput ?? 0
    this.estimatedCostUsdTotal += details.estimatedCostUsd ?? 0
  }

  observeCliSession(mode?: string, reused?: boolean, transcriptBytes?: number): void {
    if (mode === 'memory') this.memorySessionRequestsTotal += 1
    if (reused === true) this.reusedSessionRequestsTotal += 1
    this.transcriptBytesTotal += transcriptBytes ?? 0
  }

  snapshot(): Readonly<Record<string, number>> {
    return {
      requests_total: this.requestsTotal,
      request_duration_ms_total: this.requestDurationMsTotal,
      upstream_errors_total: this.upstreamErrorsTotal,
      rate_limit_total: this.rateLimitTotal,
      active_streams: this.activeStreams,
      input_tokens_total: this.inputTokensTotal,
      output_tokens_total: this.outputTokensTotal,
      tokens_total: this.totalTokens,
      fresh_input_tokens_total: this.freshInputTokensTotal,
      cached_input_tokens_total: this.cachedInputTokensTotal,
      cache_creation_input_tokens_total: this.cacheCreationInputTokensTotal,
      cache_read_input_tokens_total: this.cacheReadInputTokensTotal,
      reasoning_output_tokens_total: this.reasoningOutputTokensTotal,
      estimated_cost_usd_total: this.estimatedCostUsdTotal,
      memory_session_requests_total: this.memorySessionRequestsTotal,
      reused_session_requests_total: this.reusedSessionRequestsTotal,
      transcript_bytes_total: this.transcriptBytesTotal,
    }
  }
}
