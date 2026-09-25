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
import { CodexSession, type CodexThreadSettings } from './codex-session.js'

export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const

/** Nunca `approvalPolicy: never` nem `danger-full-access` (ADR-022). */
const POLICY: Readonly<Record<PermissionMode, Pick<CodexThreadSettings, 'approvalPolicy' | 'sandbox'>>> = {
  review: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  acceptEdits: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  plan: { approvalPolicy: 'untrusted', sandbox: 'read-only' },
}

const CODEX_ENV = ['CODEX_HOME']
const SAFE_NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

export interface CodexProviderConfig {
  binary: string
  inspectionCwd: string
  requestTimeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export function codexThreadSettings(options: AgentSessionOptions): CodexThreadSettings {
  if (options.workspace.kind !== 'local') throw new Error('O Codex não suporta workspace remoto nesta versão')
  return {
    cwd: options.workspace.root,
    ...POLICY[options.permissionMode],
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
  }
}

export class CodexAgentProvider implements AgentProvider {
  readonly id = 'codex' as const
  readonly adapterVersion = '1'
  readonly protocolVersion = 'codex-app-server-v2'
  readonly supportsRemoteWorkspace = false
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

  private start(
    options: AgentSessionOptions,
    context: AgentSessionContext,
    resumeThreadId?: string,
  ): Promise<AgentRuntimeSession> {
    let thread: CodexThreadSettings
    try {
      thread = codexThreadSettings(options)
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Configuração inválida'))
    }
    return CodexSession.start(context, {
      command: this.config.binary,
      args: ['app-server'],
      cwd: thread.cwd,
      env: minimalEnv(this.config.env ?? process.env, CODEX_ENV),
      thread,
      ...(resumeThreadId ? { resumeThreadId } : {}),
      clientVersion: this.adapterVersion,
      requestTimeoutMs: this.config.requestTimeoutMs ?? 30_000,
    })
  }
}
