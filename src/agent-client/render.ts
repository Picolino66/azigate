import type { AgentEvent, AgentUsage } from '../agents/core/agent-event.js'

const WORKSPACE_PREFIX = /^mcp__azigate_workspace__/u

const LABELS: Readonly<Record<string, string>> = {
  list_directory: 'LIST',
  find_file: 'FIND',
  search: 'SEARCH',
  read_file: 'READ',
  write_file: 'WRITE',
  edit_file: 'EDIT',
  mkdir: 'MKDIR',
  delete: 'DELETE',
  git_status: 'GIT STATUS',
  git_diff: 'GIT DIFF',
  git_log: 'GIT LOG',
  shell_exec: 'RUN',
  process_start: 'START',
  process_stdin: 'STDIN',
  process_output: 'OUTPUT',
  process_kill: 'KILL',
}

export const PROVIDER_NAMES: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex', agy: 'AGY' }

/** `mcp__azigate_workspace__read_file` + `src/app.ts` → `READ src/app.ts`. */
export function toolLabel(tool: string | undefined, summary?: string): string {
  const raw = tool ?? 'ferramenta'
  const base = raw.replace(WORKSPACE_PREFIX, '')
  const label = LABELS[base] ?? base.replace(/^mcp__/u, '').toUpperCase()
  const detail = summary?.replace(new RegExp(`^${base}\\s+`, 'u'), '').trim()
  return detail && detail !== base ? `${label} ${detail}` : label
}

export function formatUsage(usage: AgentUsage | undefined): string | undefined {
  if (!usage) return undefined
  const parts: string[] = []
  if (usage.inputTokens !== undefined) parts.push(`entrada ${usage.inputTokens}`)
  if (usage.outputTokens !== undefined) parts.push(`saída ${usage.outputTokens}`)
  if (usage.costUsd !== undefined) parts.push(`US$ ${usage.costUsd.toFixed(4)}`)
  return parts.length > 0 ? `tokens: ${parts.join(' · ')}` : undefined
}

/** Texto que o terminal mostra para um evento, ou `undefined` para eventos silenciosos. */
export function renderEvent(event: AgentEvent, options: { reasoning: boolean }): string | undefined {
  switch (event.event) {
    case 'message.delta':
      return event.text
    case 'reasoning.delta':
      return options.reasoning && event.text ? `\x1b[2m${event.text}\x1b[0m` : undefined
    case 'tool.started':
      return `\n  ▸ ${toolLabel(event.tool, event.summary)}\n`
    case 'tool.completed':
      return event.status === 'completed' ? undefined : `  ✗ ${toolLabel(event.tool)} (${event.status ?? 'falhou'})\n`
    case 'subagent.started':
      return '\n  ⤷ subagente iniciado\n'
    case 'subagent.completed':
      return '  ⤶ subagente concluído\n'
    case 'approval.resolved':
      return event.reason === 'client' ? undefined : `  • aprovação ${event.reason === 'timeout' ? 'expirada' : 'cancelada'}\n`
    case 'turn.failed':
      return `\n  ✗ turno falhou: ${event.error?.code ?? 'erro'}${event.error?.message ? ` — ${event.error.message}` : ''}\n`
    default:
      return undefined
  }
}
