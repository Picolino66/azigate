import type { BrokerConfig } from './config.js'
import { hardenAuthDirectory, resolveExecutable } from './isolation.js'
import type { ProcessRunnerLike } from './process-runner.js'
import type { BrokerProviderHealth, CliProviderName } from './protocol.js'

const CODEX_FLAGS = [
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--output-schema',
  '--output-last-message',
  '--json',
  '--sandbox',
] as const

export const CODEX_DISABLED_FEATURES = [
  'apps',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'enable_mcp_apps',
  'goals',
  'hooks',
  'image_generation',
  'in_app_browser',
  'multi_agent',
  'multi_agent_v2',
  'plugin_hooks',
  'plugins',
  'shell_snapshot',
  'shell_tool',
  'skill_mcp_dependency_install',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'unified_exec',
  'workspace_dependencies',
] as const

const CLAUDE_FLAGS = [
  '--print',
  '--output-format',
  '--json-schema',
  '--tools',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--no-chrome',
  '--no-session-persistence',
  '--setting-sources',
  '--settings',
  '--permission-mode',
] as const

export interface ProviderCapability extends BrokerProviderHealth {
  binaryPath?: string
  authDir?: string
}

export type ProviderCapabilities = Record<CliProviderName, ProviderCapability>

function unavailable(code: string): ProviderCapability {
  return { available: false, code }
}

async function diagnosticRun(
  runner: ProcessRunnerLike,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const result = await runner.run({
      command,
      args,
      cwd: '/tmp',
      env,
      timeoutMs: 15_000,
      killGraceMs: 1000,
      maxOutputBytes: 1_048_576,
    })
    return { ok: result.exitCode === 0 && !result.timedOut && !result.outputExceeded, stdout: result.stdout }
  } catch {
    return { ok: false, stdout: '' }
  }
}

async function bwrapAvailable(config: BrokerConfig, runner: ProcessRunnerLike): Promise<boolean> {
  try {
    const binary = resolveExecutable(config.bwrapPath)
    const result = await diagnosticRun(
      runner,
      binary,
      [
        '--unshare-all',
        '--share-net',
        '--die-with-parent',
        '--new-session',
        '--ro-bind', '/usr', '/usr',
        '--ro-bind', '/bin', '/bin',
        '--ro-bind', '/lib', '/lib',
        '--ro-bind', '/lib64', '/lib64',
        '--proc', '/proc',
        '--dev', '/dev',
        '--', '/usr/bin/true',
      ],
      { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    )
    return result.ok
  } catch {
    return false
  }
}

async function inspectCodex(config: BrokerConfig, runner: ProcessRunnerLike): Promise<ProviderCapability> {
  if (!config.enableCodex) return unavailable('disabled')
  let binaryPath: string
  let authDir: string
  try {
    binaryPath = resolveExecutable(config.codexPath)
    authDir = hardenAuthDirectory(config.codexAuthDir)
  } catch {
    return unavailable('filesystem_unavailable')
  }
  const env = {
    HOME: '/home/agent',
    CODEX_HOME: authDir,
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
  }
  const help = await diagnosticRun(runner, binaryPath, ['exec', '--help'], env)
  if (!help.ok || CODEX_FLAGS.some((flag) => !help.stdout.includes(flag))) return unavailable('required_flag_missing')
  const features = await diagnosticRun(runner, binaryPath, ['features', 'list'], env)
  if (!features.ok || CODEX_DISABLED_FEATURES.some((feature) => !features.stdout.includes(feature))) {
    return unavailable('required_feature_missing')
  }
  const auth = await diagnosticRun(runner, binaryPath, ['login', 'status'], env)
  if (!auth.ok) return unavailable('not_authenticated')
  return { available: true, binaryPath, authDir }
}

async function inspectClaude(config: BrokerConfig, runner: ProcessRunnerLike): Promise<ProviderCapability> {
  if (!config.enableClaude) return unavailable('disabled')
  let binaryPath: string
  let authDir: string
  try {
    binaryPath = resolveExecutable(config.claudePath)
    authDir = hardenAuthDirectory(config.claudeAuthDir)
  } catch {
    return unavailable('filesystem_unavailable')
  }
  const env = {
    HOME: authDir.substring(0, authDir.lastIndexOf('/')) || '/home/agent',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
  }
  const help = await diagnosticRun(runner, binaryPath, ['--help'], env)
  if (!help.ok || CLAUDE_FLAGS.some((flag) => !help.stdout.includes(flag))) return unavailable('required_flag_missing')
  const auth = await diagnosticRun(runner, binaryPath, ['auth', 'status'], env)
  if (!auth.ok) return unavailable('not_authenticated')
  return { available: true, binaryPath, authDir }
}

export async function inspectCapabilities(
  config: BrokerConfig,
  runner: ProcessRunnerLike,
): Promise<ProviderCapabilities> {
  if (!(await bwrapAvailable(config, runner))) {
    return { codex: unavailable('bwrap_unavailable'), claude: unavailable('bwrap_unavailable') }
  }
  const [codex, claude] = await Promise.all([inspectCodex(config, runner), inspectClaude(config, runner)])
  return { codex, claude }
}
