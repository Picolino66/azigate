import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrokerConfig } from './config.js'
import type { ProviderCapabilities } from './capabilities.js'
import { CODEX_DISABLED_FEATURES } from './capabilities.js'
import { buildIsolationCommand } from './isolation.js'
import type { ProcessRunResult, ProcessRunnerLike } from './process-runner.js'
import type { BrokerDecision, BrokerExecuteRequest, BrokerExecuteResponse, BrokerUsage } from './protocol.js'
import { BROKER_PROTOCOL_VERSION } from './protocol.js'
import { canonicalPrompt, DECISION_JSON_SCHEMA } from './prompt.js'
import { validateCliDecision } from '../providers/cli-request.js'
import {
  CliExecutionFailedError,
  CliTimeoutError,
  CliUnavailableError,
  InvalidCliOutputError,
} from '../providers/errors.js'
import { ClientAbortedError } from '../upstream/errors.js'

const CLAUDE_SYSTEM_PROMPT = [
  'Atue somente como mecanismo de decisão estruturada.',
  'Não use ferramentas locais e não acesse arquivos ou comandos.',
  'Retorne exatamente o objeto exigido pelo JSON Schema.',
].join(' ')

export class CliFinalSchemaError extends InvalidCliOutputError {}

export class CliEventProtocolError extends InvalidCliOutputError {}

export class UnexpectedCliToolEventError extends InvalidCliOutputError {}

export class CliProcessExitError extends CliExecutionFailedError {
  constructor(exitCode: number | null, category: string) {
    super()
    this.name = `CliProcessExitError_${String(exitCode)}_${category}`
  }
}

export class CliTurnFailedError extends CliExecutionFailedError {
  constructor(category: string) {
    super()
    this.name = `CliTurnFailedError_${category}`
  }
}

export class CliOutputLimitError extends CliExecutionFailedError {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function rawDecision(value: unknown): BrokerDecision {
  if (!isRecord(value) || (typeof value.content !== 'string' && value.content !== null)) {
    throw new CliFinalSchemaError()
  }
  const calls = value.tool_calls
  if (!Array.isArray(calls)) throw new CliFinalSchemaError()
  return {
    content: value.content,
    toolCalls: calls.map((call) => {
      if (!isRecord(call) || typeof call.name !== 'string' || typeof call.arguments !== 'string') {
        throw new CliFinalSchemaError()
      }
      return { name: call.name, arguments: call.arguments }
    }),
  }
}

function usageFromRecord(value: unknown): BrokerUsage | undefined {
  if (!isRecord(value)) return undefined
  const promptTokens = typeof value.input_tokens === 'number' ? value.input_tokens : undefined
  const completionTokens = typeof value.output_tokens === 'number' ? value.output_tokens : undefined
  const totalTokens = promptTokens !== undefined && completionTokens !== undefined
    ? promptTokens + completionTokens
    : undefined
  if (promptTokens === undefined && completionTokens === undefined) return undefined
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  }
}

function inspectCodexEvents(stdout: string): BrokerUsage | undefined {
  let usage: BrokerUsage | undefined
  for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      throw new CliEventProtocolError()
    }
    if (!isRecord(event) || typeof event.type !== 'string') throw new CliEventProtocolError()
    if (event.type === 'turn.failed' || event.type === 'error') {
      throw new CliTurnFailedError(diagnosticCategory(JSON.stringify(event)))
    }
    if (event.type === 'item.started' || event.type === 'item.completed' || event.type === 'item.updated') {
      if (!isRecord(event.item) || !['reasoning', 'agent_message'].includes(String(event.item.type))) {
        throw new UnexpectedCliToolEventError()
      }
      continue
    }
    if (event.type === 'turn.completed') {
      usage = usageFromRecord(event.usage)
      continue
    }
    if (!['thread.started', 'turn.started'].includes(event.type)) throw new CliEventProtocolError()
  }
  return usage
}

async function boundedJsonFile(path: string, maxBytes: number): Promise<unknown> {
  const details = await stat(path)
  if (!details.isFile() || details.size > maxBytes) throw new CliFinalSchemaError()
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new CliFinalSchemaError()
  }
}

function parseClaude(stdout: string): { decision: BrokerDecision; usage?: BrokerUsage } {
  let payload: unknown
  try {
    payload = JSON.parse(stdout)
  } catch {
    throw new CliFinalSchemaError()
  }
  if (!isRecord(payload) || payload.is_error === true) throw new CliExecutionFailedError()
  if (Array.isArray(payload.permission_denials) && payload.permission_denials.length > 0) {
    throw new UnexpectedCliToolEventError()
  }
  let structured = payload.structured_output
  if (structured === undefined && typeof payload.result === 'string') {
    try {
      structured = JSON.parse(payload.result)
    } catch {
      throw new CliFinalSchemaError()
    }
  }
  if (structured === undefined && 'content' in payload && 'tool_calls' in payload) structured = payload
  const usage = usageFromRecord(payload.usage)
  return { decision: rawDecision(structured), ...(usage === undefined ? {} : { usage }) }
}

function assertProcessState(result: ProcessRunResult): void {
  if (result.aborted) throw new ClientAbortedError()
  if (result.timedOut) throw new CliTimeoutError()
  if (result.outputExceeded) throw new CliOutputLimitError()
}

function assertProcessExit(result: ProcessRunResult): void {
  if (result.exitCode !== 0) throw new CliProcessExitError(result.exitCode, processExitCategory(result.stderr))
}

function processExitCategory(stderr: string): string {
  return diagnosticCategory(stderr)
}

function diagnosticCategory(input: string): string {
  const value = input.toLowerCase()
  if (value.includes('bwrap:')) return 'bwrap'
  if (value.includes('unexpected argument') || value.includes('unrecognized option') || value.includes('usage:')) {
    return 'argument'
  }
  if (value.includes('schema')) return 'schema'
  if (value.includes('rate limit') || value.includes('rate_limit') || value.includes('429')) return 'rate_limit'
  if (value.includes('quota') || value.includes('usage limit') || value.includes('usage_limit')) return 'quota'
  if (value.includes('context window') || value.includes('context_length')) return 'context'
  if (value.includes('unsupported')) return 'unsupported'
  if (value.includes('invalid request') || value.includes('invalid_request') || value.includes('bad request')) {
    return 'invalid_request'
  }
  if (value.includes('model')) return 'model'
  if (value.includes('toml') || value.includes('config') || value.includes('feature')) return 'config'
  if (value.includes('login') || value.includes('auth') || value.includes('unauthorized') || value.includes('401')) {
    return 'authentication'
  }
  if (value.includes('permission denied') || value.includes('operation not permitted') || value.includes('read-only')) {
    return 'permission'
  }
  if (
    value.includes('network') ||
    value.includes('connection') ||
    value.includes('request') ||
    value.includes('dns') ||
    value.includes('stream disconnected') ||
    value.includes('transport')
  ) {
    return 'network'
  }
  if (value.includes('server error') || value.includes('internal server')) return 'provider'
  if (value.includes('cancel')) return 'cancelled'
  return 'unknown'
}

export class BrokerExecutor {
  constructor(
    private readonly config: BrokerConfig,
    private readonly runner: ProcessRunnerLike,
    private readonly capabilities: ProviderCapabilities,
  ) {}

  async execute(request: BrokerExecuteRequest, signal?: AbortSignal): Promise<BrokerExecuteResponse> {
    const capability = this.capabilities[request.provider]
    if (!capability.available || !capability.binaryPath || !capability.authDir) throw new CliUnavailableError()
    await mkdir(this.config.workRoot, { recursive: true, mode: 0o700 })
    await chmod(this.config.workRoot, 0o700)
    const workspace = await mkdtemp(join(this.config.workRoot, 'request-'))
    try {
      await chmod(workspace, 0o700)
      await writeFile(join(workspace, 'decision.schema.json'), JSON.stringify(DECISION_JSON_SCHEMA), { mode: 0o600 })
      await writeFile(join(workspace, 'empty-mcp.json'), '{"mcpServers":{}}', { mode: 0o600 })
      await writeFile(
        join(workspace, 'claude-settings.json'),
        '{"hooks":{},"permissions":{"allow":[],"deny":["*"]}}',
        { mode: 0o600 },
      )
      const cliArgs = request.provider === 'codex' ? this.codexArgs() : this.claudeArgs()
      const isolated = buildIsolationCommand(
        this.config,
        request.provider,
        capability.binaryPath,
        capability.authDir,
        workspace,
        cliArgs,
      )
      const result = await this.runner.run({
        command: isolated.command,
        args: isolated.args,
        cwd: workspace,
        env: isolated.env,
        stdin: canonicalPrompt(request),
        timeoutMs: this.config.executionTimeoutMs,
        killGraceMs: this.config.killGraceMs,
        maxOutputBytes: this.config.maxOutputBytes,
        ...(signal ? { signal } : {}),
      })
      assertProcessState(result)
      const codexUsage = request.provider === 'codex' ? inspectCodexEvents(result.stdout) : undefined
      assertProcessExit(result)
      const parsed = request.provider === 'codex'
        ? {
            decision: rawDecision(
              await boundedJsonFile(join(workspace, 'final.json'), this.config.maxOutputBytes),
            ),
            usage: codexUsage,
          }
        : parseClaude(result.stdout)
      const decision = validateCliDecision(parsed.decision, request)
      return {
        version: BROKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        decision,
        ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
      }
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }

  private codexArgs(): string[] {
    return [
      'exec',
      '--ephemeral',
      '--json',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '-C', '/work',
      '--output-schema', '/work/decision.schema.json',
      '--output-last-message', '/work/final.json',
      '--color', 'never',
      '-c', 'approval_policy="never"',
      '-c', 'shell_environment_policy.inherit="none"',
      '-c', 'mcp_servers={}',
      ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
      '-',
    ]
  }

  private claudeArgs(): string[] {
    return [
      '--print',
      '--input-format', 'text',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(DECISION_JSON_SCHEMA),
      '--tools', '',
      '--strict-mcp-config',
      '--mcp-config', '/work/empty-mcp.json',
      '--disable-slash-commands',
      '--no-chrome',
      '--no-session-persistence',
      '--setting-sources', '',
      '--settings', '/work/claude-settings.json',
      '--permission-mode', 'dontAsk',
      '--agents', '{}',
      '--system-prompt', CLAUDE_SYSTEM_PROMPT,
    ]
  }
}
