import { randomUUID } from 'node:crypto'
import type {
  AgentProvider,
  AgentProviderHealth,
  AgentRuntimeSession,
  AgentSessionContext,
  AgentSessionOptions,
  PermissionMode,
} from '../core/agent-provider.js'
import { minimalEnv } from '../core/process.js'
import { parseVersion, runInspectionCommand } from '../core/versions.js'
import { ClaudeSession } from './claude-session.js'

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const PERMISSION_MODE_FLAG: Readonly<Record<PermissionMode, string>> = {
  review: 'manual',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
}

/** Variáveis extras que o Claude Code usa para localizar a própria configuração. */
const CLAUDE_ENV = ['CLAUDE_CONFIG_DIR']

export interface ClaudeProviderConfig {
  binary: string
  inspectionCwd: string
  handshakeTimeoutMs?: number
  interruptGraceMs?: number
  env?: NodeJS.ProcessEnv
}

const SAFE_NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

export function buildClaudeArgs(
  options: AgentSessionOptions,
  session: { mode: 'new' | 'resume'; nativeSessionId: string },
): string[] {
  if (!SAFE_NATIVE_ID.test(session.nativeSessionId)) throw new Error('Identificador de sessão nativa inválido')
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool',
    'stdio',
    '--permission-mode',
    PERMISSION_MODE_FLAG[options.permissionMode],
    session.mode === 'new' ? '--session-id' : '--resume',
    session.nativeSessionId,
  ]
  if (options.model) args.push('--model', options.model)
  if (options.effort) args.push('--effort', options.effort)
  if (options.workspace.kind === 'remote') {
    // Nenhuma ferramenta embutida do host A: só as ferramentas MCP do worker.
    args.push('--tools', '', '--strict-mcp-config', '--mcp-config', options.workspace.mcpConfigPath)
    if (options.workspace.allowedTools.length > 0) {
      args.push('--allowedTools', options.workspace.allowedTools.join(','))
    }
  }
  return args
}

export class ClaudeAgentProvider implements AgentProvider {
  readonly id = 'claude' as const
  readonly adapterVersion = '1'
  readonly protocolVersion = 'claude-stream-json-v1'
  readonly supportsRemoteWorkspace = true
  readonly efforts = CLAUDE_EFFORTS

  constructor(private readonly config: ClaudeProviderConfig) {}

  createSession(options: AgentSessionOptions, context: AgentSessionContext): Promise<AgentRuntimeSession> {
    return this.start(options, context, { mode: 'new', nativeSessionId: randomUUID() })
  }

  resumeSession(
    nativeSessionId: string,
    options: AgentSessionOptions,
    context: AgentSessionContext,
  ): Promise<AgentRuntimeSession> {
    return this.start(options, context, { mode: 'resume', nativeSessionId })
  }

  async health(): Promise<AgentProviderHealth> {
    const env = minimalEnv(this.config.env ?? process.env, CLAUDE_ENV)
    const versionResult = await runInspectionCommand(this.config.binary, ['--version'], {
      cwd: this.config.inspectionCwd,
      env,
    })
    if (!versionResult.ok) return { installed: false, authenticated: null, version: null }
    const auth = await runInspectionCommand(this.config.binary, ['auth', 'status', '--json'], {
      cwd: this.config.inspectionCwd,
      env,
    })
    let authenticated: boolean | null = null
    try {
      const parsed = JSON.parse(auth.stdout) as unknown
      if (typeof parsed === 'object' && parsed !== null && 'loggedIn' in parsed) {
        authenticated = parsed.loggedIn === true
      }
    } catch {
      authenticated = null
    }
    return { installed: true, authenticated, version: parseVersion(versionResult.stdout) }
  }

  private async start(
    options: AgentSessionOptions,
    context: AgentSessionContext,
    session: { mode: 'new' | 'resume'; nativeSessionId: string },
  ): Promise<AgentRuntimeSession> {
    const args = buildClaudeArgs(options, session)
    return ClaudeSession.start(context, {
      command: this.config.binary,
      args,
      cwd: options.workspace.kind === 'local' ? options.workspace.root : options.sessionDir,
      env: minimalEnv(this.config.env ?? process.env, CLAUDE_ENV),
      nativeSessionId: session.nativeSessionId,
      ...(options.model ? { model: options.model } : {}),
      handshakeTimeoutMs: this.config.handshakeTimeoutMs ?? 30_000,
      interruptGraceMs: this.config.interruptGraceMs ?? 10_000,
    })
  }
}
