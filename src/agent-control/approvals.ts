import type { AgentProviderId, ApprovalDecision } from '../agents/core/agent-provider.js'
import { newId } from '../agents/core/ids.js'
import { AgentPlaneError } from './errors.js'

export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'expired' | 'cancelled'
export type ApprovalResolutionReason = 'client' | 'timeout' | 'session_closed' | 'cancelled'

export interface ApprovalView {
  id: string
  sessionId: string
  turnId: string | null
  provider: AgentProviderId
  tool: string
  summary: string
  status: ApprovalStatus
  createdAt: string
  resolvedAt: string | null
}

interface ApprovalEntry {
  view: ApprovalView
  owner: string
  resolve(decision: ApprovalDecision): void
  timer: NodeJS.Timeout
  cleanup(): void
}

export interface ApprovalCreate {
  sessionId: string
  turnId: string | null
  provider: AgentProviderId
  tool: string
  summary: string
  owner: string
  timeoutMs: number
  signal?: AbortSignal
}

export interface ApprovalResolution {
  view: ApprovalView
  decision: ApprovalDecision
  reason: ApprovalResolutionReason
}

/**
 * Aprovações pendentes, somente em memória (ADR-024). Toda resolução diferente de `allow`
 * explícito do cliente resulta em negação.
 */
export class ApprovalService {
  private readonly entries = new Map<string, ApprovalEntry>()
  private readonly resolved = new Map<string, { view: ApprovalView; owner: string }>()

  constructor(
    private readonly onResolved: (resolution: ApprovalResolution) => void,
    private readonly now: () => Date = () => new Date(),
    private readonly retainResolved = 500,
  ) {}

  create(request: ApprovalCreate): { view: ApprovalView; decision: Promise<ApprovalDecision> } {
    const view: ApprovalView = {
      id: newId('apr'),
      sessionId: request.sessionId,
      turnId: request.turnId,
      provider: request.provider,
      tool: request.tool,
      summary: request.summary,
      status: 'pending',
      createdAt: this.now().toISOString(),
      resolvedAt: null,
    }
    let resolveDecision: (decision: ApprovalDecision) => void = () => undefined
    const decision = new Promise<ApprovalDecision>((resolve) => {
      resolveDecision = resolve
    })
    const onAbort = (): void => {
      this.finish(view.id, 'deny', 'cancelled', 'cancelled')
    }
    const timer = setTimeout(() => this.finish(view.id, 'deny', 'expired', 'timeout'), request.timeoutMs)
    timer.unref()
    request.signal?.addEventListener('abort', onAbort, { once: true })
    this.entries.set(view.id, {
      view,
      owner: request.owner,
      resolve: resolveDecision,
      timer,
      cleanup: () => request.signal?.removeEventListener('abort', onAbort),
    })
    if (request.signal?.aborted) onAbort()
    return { view: { ...view }, decision }
  }

  decide(owner: string, id: string, decision: unknown): ApprovalView {
    if (decision !== 'allow' && decision !== 'deny') {
      throw new AgentPlaneError(400, 'invalid_decision', 'A decisão deve ser allow ou deny')
    }
    const entry = this.entries.get(id)
    if (entry) {
      if (entry.owner !== owner) throw approvalNotFound()
      return this.finish(id, decision, decision === 'allow' ? 'allowed' : 'denied', 'client') ?? entry.view
    }
    const done = this.resolved.get(id)
    if (done && done.owner === owner) {
      throw new AgentPlaneError(409, 'approval_already_resolved', 'A aprovação já foi resolvida')
    }
    throw approvalNotFound()
  }

  pendingFor(sessionId: string): ApprovalView[] {
    return [...this.entries.values()]
      .filter((entry) => entry.view.sessionId === sessionId)
      .map((entry) => ({ ...entry.view }))
  }

  /** Nega todas as aprovações pendentes da sessão. */
  cancelForSession(sessionId: string, reason: 'session_closed' | 'cancelled'): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.view.sessionId === sessionId) this.finish(entry.view.id, 'deny', 'cancelled', reason)
    }
  }

  cancelAll(): void {
    for (const id of [...this.entries.keys()]) this.finish(id, 'deny', 'cancelled', 'session_closed')
  }

  private finish(
    id: string,
    decision: ApprovalDecision,
    status: ApprovalStatus,
    reason: ApprovalResolutionReason,
  ): ApprovalView | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    this.entries.delete(id)
    clearTimeout(entry.timer)
    entry.cleanup()
    entry.view.status = status
    entry.view.resolvedAt = this.now().toISOString()
    this.resolved.set(id, { view: { ...entry.view }, owner: entry.owner })
    if (this.resolved.size > this.retainResolved) {
      const oldest = this.resolved.keys().next().value
      if (oldest !== undefined) this.resolved.delete(oldest)
    }
    entry.resolve(decision)
    this.onResolved({ view: { ...entry.view }, decision, reason })
    return { ...entry.view }
  }
}

function approvalNotFound(): AgentPlaneError {
  return new AgentPlaneError(404, 'approval_not_found', 'Aprovação não encontrada')
}
