import { randomUUID } from 'node:crypto'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

/**
 * Ferramentas embutidas mantidas em sessão remota: subagentes, lista de tarefas e web. Tudo
 * que lê, escreve ou executa na máquina A (Read, Write, Edit, Bash, Glob, Grep…) fica de fora;
 * o projeto chega pelo MCP do Workspace Server (ADR-025).
 */
export const CLAUDE_REMOTE_BUILTIN_TOOLS = ['Task', 'TodoWrite', 'WebFetch', 'WebSearch'] as const

export function buildClaudeArgs(
  options: AgentSessionOptions,
  session: { mode: 'new' | 'resume'; nativeSessionId: string },
  mcpConfigPath?: string,
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
    if (!mcpConfigPath) throw new Error('Sessão remota sem configuração MCP')
    args.push(
      '--tools',
      CLAUDE_REMOTE_BUILTIN_TOOLS.join(','),
      '--strict-mcp-config',
      '--mcp-config',
      mcpConfigPath,
      '--allowedTools',
      options.workspace.readOnlyTools.join(','),
      '--append-system-prompt',
      options.workspace.instructions,
    )
  }
  return args
}

/** Configuração MCP do Claude: só a ponte; o token fica no arquivo de sessão 0600. */
export function writeClaudeMcpConfig(options: AgentSessionOptions): string | undefined {
  if (options.workspace.kind !== 'remote') return undefined
  const { mcp } = options.workspace
  const path = join(options.sessionDir, 'claude-mcp-config.json')
  const config = { mcpServers: { [mcp.name]: { type: 'stdio', command: mcp.command, args: [...mcp.args], env: { ...mcp.env } } } }
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

export class ClaudeAgentProvider implements AgentProvider {
  readonly id = 'claude' as const
  readonly adapterVersion = '1'
  readonly protocolVersion = 'claude-stream-json-v1'
  readonly supportsRemoteWorkspace = true
  readonly remoteApprovals = 'native' as const
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
    const args = buildClaudeArgs(options, session, writeClaudeMcpConfig(options))
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
