/**
 * Mensagens entre o webview do painel Azigate e o host da extensão (ADR-028).
 *
 * O webview é tratado como origem não confiável: toda mensagem que chega dele passa por
 * `parseInboundMessage`, que aceita só os formatos abaixo e descarta o resto. Nada do que o
 * webview envia vira caminho, comando, argv ou URL; o workspace é escolhido apenas por ID.
 */

export const PROVIDER_IDS = ['claude', 'codex', 'agy'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = { claude: 'Claude', codex: 'Codex', agy: 'AGY' }

const MAX_INPUT_CHARS = 100_000
const MAX_ID_CHARS = 128
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u

export type InboundMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'cancel' }
  | { type: 'newSession' }
  | { type: 'refresh' }
  | { type: 'selectProvider'; provider: ProviderId }
  | { type: 'selectWorkspace'; workspace: string }
  | { type: 'decide'; approvalId: string; decision: 'allow' | 'deny' }
  | { type: 'startServer' }
  | { type: 'stopServer' }

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'failed'

export interface ProviderState {
  id: ProviderId
  label: string
  /** `undefined` quando o agentd ainda não respondeu. */
  available: boolean | undefined
}

export interface ViewState {
  provider: ProviderId
  providers: ProviderState[]
  workspaces: string[]
  workspace: string | undefined
  /** Workspace Server conectado ao agentd que expõe o workspace escolhido. */
  workspaceWorker: string | undefined
  session: { id: string; provider: string; worker: string | null } | undefined
  busy: boolean
  server: { status: ServerStatus; detail?: string }
  connection: { ok: boolean; message?: string }
}

export type ChatEntry =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; provider: string }
  | { kind: 'tool'; label: string }
  | { kind: 'tool-failed'; label: string; status: string }
  | { kind: 'info'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'usage'; text: string }

export type OutboundMessage =
  | { type: 'state'; state: ViewState }
  | { type: 'entry'; entry: ChatEntry }
  | { type: 'delta'; text: string }
  | { type: 'approval'; approvalId: string; label: string }
  | { type: 'approvalResolved'; approvalId: string; text: string }
  | { type: 'reset' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS && ID_PATTERN.test(value)
}

/** Valida uma mensagem vinda do webview; devolve `undefined` para qualquer formato inesperado. */
export function parseInboundMessage(raw: unknown): InboundMessage | undefined {
  if (!isRecord(raw) || typeof raw.type !== 'string') return undefined
  switch (raw.type) {
    case 'ready':
    case 'cancel':
    case 'newSession':
    case 'refresh':
    case 'startServer':
    case 'stopServer':
      return { type: raw.type }
    case 'send': {
      if (typeof raw.text !== 'string') return undefined
      const text = raw.text.trim()
      if (text === '' || text.length > MAX_INPUT_CHARS) return undefined
      return { type: 'send', text }
    }
    case 'selectProvider':
      return isProviderId(raw.provider) ? { type: 'selectProvider', provider: raw.provider } : undefined
    case 'selectWorkspace':
      return isSafeId(raw.workspace) ? { type: 'selectWorkspace', workspace: raw.workspace } : undefined
    case 'decide':
      if (!isSafeId(raw.approvalId)) return undefined
      if (raw.decision !== 'allow' && raw.decision !== 'deny') return undefined
      return { type: 'decide', approvalId: raw.approvalId, decision: raw.decision }
    default:
      return undefined
  }
}
