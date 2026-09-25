import { execFile } from 'node:child_process'
import type { AgentProviderId } from './agent-provider.js'
import { minimalEnv } from './process.js'

/**
 * Versões validadas contra os protocolos nativos (ADR-022). Uma CLI fora desta matriz gera
 * aviso ou é desabilitada, conforme `AGENT_VERSION_POLICY`.
 */
export const CERTIFIED_VERSIONS: Readonly<Record<AgentProviderId, readonly string[]>> = {
  codex: ['0.144.6'],
  claude: ['2.1.280'],
  agy: ['1.2.10', '1.2.11'],
}

export function parseVersion(output: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/u.exec(output)?.[1] ?? null
}

export function isCertified(provider: AgentProviderId, version: string | null): boolean {
  return version !== null && CERTIFIED_VERSIONS[provider].includes(version)
}

export interface CommandResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  /** `true` quando o binário não foi encontrado ou não pôde ser executado. */
  missing: boolean
}

/** Executa um comando curto de inspeção (versão/status), sem shell e com ambiente mínimo. */
export function runInspectionCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        env: options.env ?? minimalEnv(process.env),
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: 256 * 1024,
        shell: false,
        windowsHide: true,
      },
      (error, stdout) => {
        const errorRecord = error as (NodeJS.ErrnoException & { code?: unknown }) | null
        const missing = errorRecord?.code === 'ENOENT' || errorRecord?.code === 'EACCES'
        const exitCode = error ? (typeof errorRecord?.code === 'number' ? errorRecord.code : null) : 0
        resolve({ ok: !error, exitCode, stdout: String(stdout), missing })
      },
    )
  })
}
