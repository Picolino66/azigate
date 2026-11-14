import type { AgentEvent } from '../agents/core/agent-event.js'

export class AgentApiError extends Error {
  override readonly name = 'AgentApiError'
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface WorkerInfo {
  id: string
  workspaces: string[]
  capabilities: string[]
}

export interface SessionInfo {
  id: string
  provider: string
  status: string
  workspace: string
  worker: string | null
  model: string | null
  nativeSessionId: string | null
}

/** Cliente HTTP da Agent API (`/agent/v1`). Não é OpenAI-compatible. */
export class AgentApi {
  private readonly base: string

  constructor(
    baseUrl: string,
    private readonly key: string,
  ) {
    this.base = baseUrl.replace(/\/+$/u, '')
  }

  get host(): string {
    return new URL(this.base).host
  }

  providers(): Promise<Record<string, Record<string, unknown>>> {
    return this.request('GET', '/agent/v1/providers')
  }

  async workers(): Promise<WorkerInfo[]> {
    const body = await this.request<{ data: WorkerInfo[] }>('GET', '/agent/v1/workers')
    return body.data
  }

  createSession(body: Record<string, unknown>): Promise<SessionInfo> {
    return this.request('POST', '/agent/v1/sessions', body)
  }

  session(id: string): Promise<SessionInfo> {
    return this.request('GET', `/agent/v1/sessions/${encodeURIComponent(id)}`)
  }

  sendTurn(id: string, input: string): Promise<{ turnId: string }> {
    return this.request('POST', `/agent/v1/sessions/${encodeURIComponent(id)}/turns`, { input })
  }

  decide(approvalId: string, decision: 'allow' | 'deny'): Promise<unknown> {
    return this.request('POST', `/agent/v1/approvals/${encodeURIComponent(approvalId)}`, { decision })
  }

  cancel(id: string): Promise<unknown> {
    return this.request('POST', `/agent/v1/sessions/${encodeURIComponent(id)}/cancel`)
  }

  close(id: string): Promise<SessionInfo> {
    return this.request('DELETE', `/agent/v1/sessions/${encodeURIComponent(id)}`)
  }

  /** Stream SSE de eventos a partir de `after`. Termina quando a sessão fecha ou `signal` aborta. */
  async *events(id: string, after: number, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const response = await fetch(`${this.base}/agent/v1/sessions/${encodeURIComponent(id)}/events?after=${after}`, {
      headers: { authorization: `Bearer ${this.key}`, accept: 'text/event-stream' },
      signal,
    })
    if (!response.ok || !response.body) throw await this.failure(response)
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('\n')
        if (data) yield JSON.parse(data) as AgentEvent
        boundary = buffer.indexOf('\n\n')
      }
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.key}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw await this.failure(response)
    return (await response.json()) as T
  }

  private async failure(response: Response): Promise<AgentApiError> {
    let code = 'http_error'
    let message = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } }
      code = body.error?.code ?? code
      message = body.error?.message ?? message
    } catch {
      // corpo não é JSON
    }
    return new AgentApiError(response.status, code, message)
  }
}
