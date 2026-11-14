import type {
  AgentProvider,
  AgentProviderHealth,
  AgentRuntimeSession,
  AgentSessionContext,
  AgentSessionOptions,
  McpServerLaunch,
  PermissionMode,
} from '../core/agent-provider.js'
import { minimalEnv } from '../core/process.js'
import { parseVersion, runInspectionCommand } from '../core/versions.js'
import { CodexSession, type CodexThreadSettings } from './codex-session.js'

export const CODEX_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Nunca `approvalPolicy: never` nem `danger-full-access` (ADR-022). */
const POLICY: Readonly<Record<PermissionMode, Pick<CodexThreadSettings, 'approvalPolicy' | 'sandbox'>>> = {
  review: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  acceptEdits: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  plan: { approvalPolicy: 'untrusted', sandbox: 'read-only' },
}

/**
 * Recursos do Codex 0.144.6 que agiriam na máquina A e ficam desligados em sessão remota:
 * shell e exec unificado, navegador e controle do computador (ADR-025). Escritas por
 * `apply_patch` esbarram no sandbox `read-only` e têm a aprovação negada pelo adaptador.
 */
export const CODEX_REMOTE_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
] as const

const CODEX_ENV = ['CODEX_HOME']
const SAFE_NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SAFE_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/u

export interface CodexProviderConfig {
  binary: string
  inspectionCwd: string
  requestTimeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export function codexThreadSettings(options: AgentSessionOptions): CodexThreadSettings {
  const base = {
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
  }
  if (options.workspace.kind === 'local') {
    return { cwd: options.workspace.root, ...POLICY[options.permissionMode], ...base }
  }
  // Remoto: cwd vazio e privado em A; o projeto só existe através do MCP.
  return {
    cwd: options.sessionDir,
    approvalPolicy: 'untrusted',
    sandbox: 'read-only',
    developerInstructions: options.workspace.instructions,
    ...base,
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** Servidor MCP configurado pelo usuário, com o campo de transporte que o Codex exige. */
export interface CodexMcpServerEntry {
  name: string
  command?: string
  url?: string
}

/** Argumentos `codex app-server` para uma sessão remota: MCP do Azigate e nada local. */
export function buildCodexRemoteArgs(mcp: McpServerLaunch, otherServers: readonly CodexMcpServerEntry[]): string[] {
  const args = ['app-server']
  for (const feature of CODEX_REMOTE_DISABLED_FEATURES) args.push('--disable', feature)
  const prefix = `mcp_servers.${mcp.name}`
  const env = Object.entries(mcp.env).map(([key, value]) => `${key} = ${tomlString(value)}`)
  args.push(
    '-c',
    `${prefix}.command=${tomlString(mcp.command)}`,
    '-c',
    `${prefix}.args=[${mcp.args.map(tomlString).join(', ')}]`,
    '-c',
    `${prefix}.env={ ${env.join(', ')} }`,
    '-c',
    // A aprovação das ferramentas remotas é feita pelo agentd antes de repassar ao worker.
    `${prefix}.default_tools_approval_mode="approve"`,
  )
  // O Codex 0.144.6 recusa uma entrada só com `enabled`: o transporte precisa ir junto.
  for (const server of otherServers) {
    if (server.name === mcp.name || !SAFE_SERVER_NAME.test(server.name)) continue
    const transport = server.command !== undefined ? `command=${tomlString(server.command)}` : server.url !== undefined ? `url=${tomlString(server.url)}` : undefined
    if (!transport) continue
    args.push('-c', `mcp_servers.${server.name}.${transport}`, '-c', `mcp_servers.${server.name}.enabled=false`)
  }
  return args
}

export class CodexAgentProvider implements AgentProvider {
  readonly id = 'codex' as const
  readonly adapterVersion = '1'
  readonly protocolVersion = 'codex-app-server-v2'
  readonly supportsRemoteWorkspace = true
  readonly remoteApprovals = 'gateway' as const
  readonly efforts = CODEX_EFFORTS

  constructor(private readonly config: CodexProviderConfig) {}

  createSession(options: AgentSessionOptions, context: AgentSessionContext): Promise<AgentRuntimeSession> {
    return this.start(options, context)
  }

  resumeSession(
    nativeSessionId: string,
    options: AgentSessionOptions,
    context: AgentSessionContext,
  ): Promise<AgentRuntimeSession> {
    if (!SAFE_NATIVE_ID.test(nativeSessionId)) return Promise.reject(new Error('Identificador de thread inválido'))
    return this.start(options, context, nativeSessionId)
  }

  async health(): Promise<AgentProviderHealth> {
    const env = minimalEnv(this.config.env ?? process.env, CODEX_ENV)
    const versionResult = await runInspectionCommand(this.config.binary, ['--version'], {
      cwd: this.config.inspectionCwd,
      env,
    })
    if (!versionResult.ok) return { installed: false, authenticated: null, version: null }
    const login = await runInspectionCommand(this.config.binary, ['login', 'status'], {
      cwd: this.config.inspectionCwd,
      env,
    })
    return {
      installed: true,
      authenticated: login.missing ? null : login.ok,
      version: parseVersion(versionResult.stdout),
    }
  }

  /** Servidores MCP do usuário, para desligá-los na sessão remota (paridade com `--strict-mcp-config`). */
  private async configuredMcpServers(cwd: string, env: NodeJS.ProcessEnv): Promise<CodexMcpServerEntry[]> {
    const listed = await runInspectionCommand(this.config.binary, ['mcp', 'list', '--json'], { cwd, env })
    try {
      const parsed = JSON.parse(listed.stdout) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.flatMap((entry): CodexMcpServerEntry[] => {
        if (typeof entry !== 'object' || entry === null) return []
        const record = entry as { name?: unknown; transport?: { command?: unknown; url?: unknown } }
        if (typeof record.name !== 'string') return []
        const transport = record.transport ?? {}
        return [{
          name: record.name,
          ...(typeof transport.command === 'string' ? { command: transport.command } : {}),
          ...(typeof transport.url === 'string' ? { url: transport.url } : {}),
        }]
      })
    } catch {
      return []
    }
  }

  private async start(
    options: AgentSessionOptions,
    context: AgentSessionContext,
    resumeThreadId?: string,
  ): Promise<AgentRuntimeSession> {
    const thread = codexThreadSettings(options)
    const env = minimalEnv(this.config.env ?? process.env, CODEX_ENV)
    const args =
      options.workspace.kind === 'remote'
        ? buildCodexRemoteArgs(options.workspace.mcp, await this.configuredMcpServers(thread.cwd, env))
        : ['app-server']
    return CodexSession.start(context, {
      command: this.config.binary,
      args,
      cwd: thread.cwd,
      env,
      thread,
      remote: options.workspace.kind === 'remote',
      ...(resumeThreadId ? { resumeThreadId } : {}),
      clientVersion: this.adapterVersion,
      requestTimeoutMs: this.config.requestTimeoutMs ?? 30_000,
    })
  }
}
