import type {
  AgentProvider,
  AgentProviderHealth,
  AgentRuntimeSession,
  AgentSessionContext,
  AgentSessionOptions,
  PermissionMode,
} from '../core/agent-provider.js'
import { minimalEnv } from '../core/process.js'
import { AgentStartError } from '../core/process-session.js'
import { parseVersion, runInspectionCommand } from '../core/versions.js'
import { AGY_REMOTE_AGENT, agyRemoteStatus } from './agy-remote-setup.js'
import { AgySession } from './agy-session.js'

export const AGY_EFFORTS = ['low', 'medium', 'high'] as const

/** `review` mantém o modo padrão do AGY (`request-review`); nunca `--dangerously-skip-permissions`. */
const MODE_FLAG: Readonly<Record<PermissionMode, string | undefined>> = {
  review: undefined,
  acceptEdits: 'accept-edits',
  plan: 'plan',
}

const SAFE_NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

export interface AgyProviderConfig {
  binary: string
  inspectionCwd: string
  initTimeoutMs?: number
  interruptGraceMs?: number
  env?: NodeJS.ProcessEnv
}

export function buildAgyArgs(options: AgentSessionOptions, conversationId?: string): string[] {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json']
  // Workspace remoto: agente sem ferramentas embutidas da máquina A, só o MCP do Azigate.
  if (options.workspace.kind === 'remote') args.push('--agent', AGY_REMOTE_AGENT)
  if (conversationId !== undefined) {
    if (!SAFE_NATIVE_ID.test(conversationId)) throw new Error('Identificador de conversa inválido')
    args.push('--conversation', conversationId)
  }
  if (options.model) args.push('--model', options.model)
  if (options.effort) args.push('--effort', options.effort)
  const mode = MODE_FLAG[options.permissionMode]
  if (mode) args.push('--mode', mode)
  return args
}

export class AgyAgentProvider implements AgentProvider {
  readonly id = 'agy' as const
  readonly adapterVersion = '1'
  readonly protocolVersion = 'agy-stream-json-v1'
  readonly supportsRemoteWorkspace = true
  readonly remoteApprovals = 'gateway' as const
  readonly efforts = AGY_EFFORTS

  constructor(private readonly config: AgyProviderConfig) {}

  createSession(options: AgentSessionOptions, context: AgentSessionContext): Promise<AgentRuntimeSession> {
    return this.start(options, context)
  }

  resumeSession(
    nativeSessionId: string,
    options: AgentSessionOptions,
    context: AgentSessionContext,
  ): Promise<AgentRuntimeSession> {
    return this.start(options, context, nativeSessionId)
  }

  async health(): Promise<AgentProviderHealth> {
    const env = minimalEnv(this.config.env ?? process.env)
    const versionResult = await runInspectionCommand(this.config.binary, ['--version'], {
      cwd: this.config.inspectionCwd,
      env,
    })
    if (!versionResult.ok) return { installed: false, authenticated: null, version: null }
    // `/model` é respondido pela própria CLI: não inicia turno nem consome cota.
    const probe = await runInspectionCommand(this.config.binary, ['-p=/model', '--output-format', 'json'], {
      cwd: this.config.inspectionCwd,
      env,
    })
    let authenticated: boolean | null = null
    try {
      const parsed = JSON.parse(probe.stdout) as unknown
      if (typeof parsed === 'object' && parsed !== null && 'status' in parsed) {
        authenticated = parsed.status === 'SUCCESS'
      }
    } catch {
      authenticated = probe.ok ? null : false
    }
    return { installed: true, authenticated, version: parseVersion(versionResult.stdout) }
  }

  private async start(
    options: AgentSessionOptions,
    context: AgentSessionContext,
    conversationId?: string,
  ): Promise<AgentRuntimeSession> {
    const source = this.config.env ?? process.env
    const workspace = options.workspace
    let cwd: string
    let env: NodeJS.ProcessEnv
    if (workspace.kind === 'local') {
      cwd = workspace.root
      env = minimalEnv(source)
    } else {
      if (!agyRemoteStatus(source.HOME ?? '').ready) {
        throw new AgentStartError('AGY sem preparação para workspace remoto: rode npm run agy:remote -- install')
      }
      // A ponte MCP registrada no AGY herda o ambiente e descobre a sessão por esta variável.
      cwd = options.sessionDir
      env = minimalEnv(source, [], { ...workspace.mcp.env })
    }
    return AgySession.start(context, {
      command: this.config.binary,
      args: buildAgyArgs(options, conversationId),
      cwd,
      env,
      ...(conversationId ? { expectedConversationId: conversationId } : {}),
      ...(options.model ? { model: options.model } : {}),
      initTimeoutMs: this.config.initTimeoutMs ?? 30_000,
      interruptGraceMs: this.config.interruptGraceMs ?? 10_000,
    })
  }
}
