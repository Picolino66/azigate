interface Bucket {
  count: number
  resetAt: number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor(
    private readonly windowMs: number,
    private readonly maxByCredential: number,
    private readonly maxByIp: number,
  ) {}

  consume(credentialId: string, ip: string, now = Date.now()): RateLimitResult {
    const credential = this.increment(`credential:${credentialId}`, this.maxByCredential, now)
    const ipLimit = this.increment(`ip:${ip}`, this.maxByIp, now)
    const allowed = credential.allowed && ipLimit.allowed
    return {
      allowed,
      remaining: Math.max(0, Math.min(credential.remaining, ipLimit.remaining)),
      retryAfterSeconds: Math.max(credential.retryAfterSeconds, ipLimit.retryAfterSeconds),
    }
  }

  private increment(key: string, max: number, now: number): RateLimitResult {
    let bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs }
      this.buckets.set(key, bucket)
    }
    bucket.count += 1
    if (this.buckets.size > 10_000) this.prune(now)
    return {
      allowed: bucket.count <= max,
      remaining: max - bucket.count,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    }
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
  }
}
