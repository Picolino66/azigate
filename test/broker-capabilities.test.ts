import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_DISABLED_FEATURES, inspectCapabilities } from '../src/broker/capabilities.js'
import { loadBrokerConfig, type BrokerConfig } from '../src/broker/config.js'
import { buildIsolationCommand, hardenAuthDirectory, resolveExecutable } from '../src/broker/isolation.js'
import type { ProcessRunResult, ProcessRunnerLike, ProcessRunSpec } from '../src/broker/process-runner.js'

const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'gateway-ai-capabilities-'))
  roots.push(value)
  return value
}

afterEach(() => roots.splice(0).forEach((value) => rmSync(value, { recursive: true, force: true })))

function result(stdout: string, exitCode = 0): ProcessRunResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    aborted: false,
    outputExceeded: false,
  }
}

const CODEX_HELP = [
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--output-schema',
  '--output-last-message',
  '--json',
  '--sandbox',
].join('\n')

const CLAUDE_HELP = [
  '--print',
  '--effort',
  '--input-format',
  '--output-format',
  '--json-schema',
  '--tools',
  '--mcp-config',
  '--model',
  '--strict-mcp-config',
  '--agents',
  '--system-prompt',
  '--disable-slash-commands',
  '--no-chrome',
  '--no-session-persistence',
  '--setting-sources',
  '--settings',
  '--permission-mode',
].join('\n')

class CapabilityRunner implements ProcessRunnerLike {
  readonly calls: ProcessRunSpec[] = []

  constructor(
    private readonly failure: 'none' | 'bwrap' | 'codex_help' | 'features' | 'codex_auth' | 'claude_help' = 'none',
  ) {}

  run(spec: ProcessRunSpec): Promise<ProcessRunResult> {
    this.calls.push(spec)
    if (spec.args[0] === '--unshare-all') return Promise.resolve(result('', this.failure === 'bwrap' ? 1 : 0))
    if (spec.args[0] === 'exec') return Promise.resolve(result(this.failure === 'codex_help' ? '' : CODEX_HELP))
    if (spec.args[0] === 'features') {
      return Promise.resolve(result(this.failure === 'features' ? '' : CODEX_DISABLED_FEATURES.join('\n')))
    }
    if (spec.args[0] === 'login') return Promise.resolve(result('', this.failure === 'codex_auth' ? 1 : 0))
    if (spec.args[0] === '--help') {
      return Promise.resolve(result(this.failure === 'claude_help' ? '' : CLAUDE_HELP))
    }
    if (spec.args[0] === 'auth') return Promise.resolve(result(''))
    return Promise.resolve(result('', 1))
  }
}

function brokerConfig(directory: string): BrokerConfig {
  const codexAuth = join(directory, 'codex-auth')
  const claudeAuth = join(directory, 'claude-auth')
  mkdirSync(codexAuth, { mode: 0o755 })
  mkdirSync(claudeAuth, { mode: 0o755 })
  return {
    socketPath: join(directory, 'run', 'broker.sock'),
    workRoot: join(directory, 'work'),
    enableCodex: true,
    enableClaude: true,
    executionTimeoutMs: 1000,
    killGraceMs: 100,
    maxOutputBytes: 1_048_576,
    maxRequestBytes: 1_048_576,
    bwrapPath: process.execPath,
    codexPath: process.execPath,
    claudePath: process.execPath,
    codexAuthDir: codexAuth,
    claudeAuthDir: claudeAuth,
  }
}

describe('configuração e capacidades do broker', () => {
  it('carrega defaults e valida paths, booleanos e inteiros', () => {
    const home = root()
    const config = loadBrokerConfig({ HOME: home })
    expect(config.socketPath).toBe('/run/gateway-ai/broker.sock')
    expect(config.executionTimeoutMs).toBe(600_000)
    expect(config.enableCodex).toBe(true)
    expect(config.enableClaude).toBe(false)
    expect(() => loadBrokerConfig({ HOME: home, BROKER_SOCKET_PATH: 'relativo' })).toThrow(/absoluto/u)
    expect(() => loadBrokerConfig({ HOME: home, BROKER_ENABLE_CODEX_CLI: 'sim' })).toThrow(/true ou false/u)
    expect(() => loadBrokerConfig({ HOME: home, BROKER_MAX_OUTPUT_BYTES: '1' })).toThrow(/inteiro/u)
  })

  it('aprova binários, auth, flags e features exigidos sem registrar saídas', async () => {
    const directory = root()
    const config = brokerConfig(directory)
    const runner = new CapabilityRunner()
    const capabilities = await inspectCapabilities(config, runner)
    expect(capabilities.codex.available).toBe(true)
    expect(capabilities.claude.available).toBe(true)
    expect(runner.calls).toHaveLength(6)
    expect((globalThis.process.getuid?.() ?? 0) >= 0).toBe(true)
    expect(statSync(config.codexAuthDir).mode & 0o777).toBe(0o700)
  })

  it.each([
    ['bwrap', 'bwrap_unavailable'],
    ['codex_help', 'required_flag_missing'],
    ['features', 'required_feature_missing'],
    ['codex_auth', 'not_authenticated'],
  ] as const)('falha fechada em %s', async (failure, code) => {
    const config = brokerConfig(root())
    config.enableClaude = false
    const capabilities = await inspectCapabilities(config, new CapabilityRunner(failure))
    expect(capabilities.codex).toMatchObject({ available: false, code })
  })

  it('não publica Claude quando uma flag obrigatória está ausente', async () => {
    const config = brokerConfig(root())
    config.enableCodex = false
    const capabilities = await inspectCapabilities(config, new CapabilityRunner('claude_help'))
    expect(capabilities.claude).toMatchObject({ available: false, code: 'required_flag_missing' })
  })

  it('marca providers desabilitados sem executar seus diagnósticos', async () => {
    const config = brokerConfig(root())
    config.enableCodex = false
    config.enableClaude = false
    const runner = new CapabilityRunner()
    const capabilities = await inspectCapabilities(config, runner)
    expect(capabilities).toMatchObject({
      codex: { available: false, code: 'disabled' },
      claude: { available: false, code: 'disabled' },
    })
    expect(runner.calls).toHaveLength(1)
  })

  it('resolve executável absoluto, endurece auth e monta binário externo isoladamente', () => {
    const directory = root()
    const executable = join(directory, 'cli-falso')
    const auth = join(directory, 'auth')
    const work = join(directory, 'work')
    writeFileSync(executable, '#!/bin/sh\nexit 0\n')
    chmodSync(executable, 0o700)
    mkdirSync(auth, { mode: 0o755 })
    mkdirSync(work)
    expect(resolveExecutable(executable)).toBe(executable)
    expect(hardenAuthDirectory(auth)).toBe(auth)
    expect(() => resolveExecutable('cli-relativo')).toThrow(/absoluto/u)
    const command = buildIsolationCommand(
      { ...brokerConfig(directory), bwrapPath: process.execPath },
      'claude',
      executable,
      auth,
      work,
      ['--print'],
    )
    expect(command.args).toContain('/opt/cli/claude-cli-falso')
    expect(command.args).toContain('--clearenv')
    expect(command.args.filter((value) => value === '/etc')).toHaveLength(1)
    expect(command.args).toContain('/etc/resolv.conf')
    expect(command.args).toContain('/etc/ssl/certs')
  })
})
