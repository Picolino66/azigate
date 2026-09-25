import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEventDraft } from '../../src/agents/core/agent-event.js'
import type {
  AgentSessionContext,
  AgentSessionOptions,
  ApprovalDecision,
  ApprovalRequest,
} from '../../src/agents/core/agent-provider.js'

export function fakeBinary(name: 'fake-claude' | 'fake-agy' | 'fake-codex'): string {
  return fileURLToPath(new URL(`../fixtures/agents/${name}.mjs`, import.meta.url))
}

export function tempDir(prefix = 'azigate-agent-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export interface TestContext extends AgentSessionContext {
  emitted: AgentEventDraft[]
  approvals: ApprovalRequest[]
  diagnostics: string[]
}

export function testContext(decide: (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision> = () => 'deny'): TestContext {
  const context: TestContext = {
    emitted: [],
    approvals: [],
    diagnostics: [],
    requestApproval: async (request) => {
      context.approvals.push(request)
      return decide(request)
    },
    emit: (event) => context.emitted.push(event),
    diagnostic: (event) => context.diagnostics.push(event),
  }
  return context
}

export function localOptions(root: string, overrides: Partial<AgentSessionOptions> = {}): AgentSessionOptions {
  return {
    sessionId: 'agt_000000000000000000000000',
    workspace: { kind: 'local', id: 'teste', root },
    sessionDir: root,
    permissionMode: 'review',
    ...overrides,
  }
}

export async function collect(iterable: AsyncIterable<AgentEventDraft>): Promise<AgentEventDraft[]> {
  const events: AgentEventDraft[] = []
  for await (const event of iterable) events.push(event)
  return events
}

export function types(events: readonly AgentEventDraft[]): string[] {
  return events.map((event) => event.event)
}
