export class GatewayMetrics {
  requestsTotal = 0
  upstreamErrorsTotal = 0
  rateLimitTotal = 0
  activeStreams = 0
  inputTokensTotal = 0
  outputTokensTotal = 0
  totalTokens = 0
  requestDurationMsTotal = 0

  observeDuration(durationMs: number): void {
    this.requestDurationMsTotal += durationMs
  }

  observeTokens(input?: number, output?: number, total?: number): void {
    this.inputTokensTotal += input ?? 0
    this.outputTokensTotal += output ?? 0
    this.totalTokens += total ?? 0
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
    }
  }
}
