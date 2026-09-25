import type { AgentEvent } from '../agents/core/agent-event.js'

interface StoredEvent {
  event: AgentEvent
  bytes: number
}

type Subscriber = (event: AgentEvent | null) => void

/**
 * Buffer circular de eventos de uma sessão, somente em memória (ADR-024). Limitado por
 * quantidade e por bytes aproximados; eventos antigos são descartados. `null` sinaliza
 * aos assinantes que a sessão foi encerrada.
 */
export class SessionEventLog {
  private readonly events: StoredEvent[] = []
  private totalBytes = 0
  private nextId = 1
  private readonly subscribers = new Set<Subscriber>()
  private closed = false

  constructor(
    private readonly maxEvents: number,
    private readonly maxBytes: number,
  ) {}

  append(event: Omit<AgentEvent, 'id'>): AgentEvent {
    const numbered = { id: this.nextId++, ...event }
    const bytes = Buffer.byteLength(JSON.stringify(numbered))
    this.events.push({ event: numbered, bytes })
    this.totalBytes += bytes
    while (this.events.length > 1 && (this.events.length > this.maxEvents || this.totalBytes > this.maxBytes)) {
      const removed = this.events.shift()
      if (removed) this.totalBytes -= removed.bytes
    }
    for (const subscriber of this.subscribers) subscriber(numbered)
    return numbered
  }

  since(afterId: number): AgentEvent[] {
    return this.events.filter((stored) => stored.event.id > afterId).map((stored) => stored.event)
  }

  get lastId(): number {
    return this.nextId - 1
  }

  get isClosed(): boolean {
    return this.closed
  }

  subscribe(subscriber: Subscriber): () => void {
    if (this.closed) {
      subscriber(null)
      return () => undefined
    }
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const subscriber of this.subscribers) subscriber(null)
    this.subscribers.clear()
  }
}
