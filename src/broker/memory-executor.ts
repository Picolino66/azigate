import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrokerConfig } from './config.js'
import type { ProviderCapabilities } from './capabilities.js'
import { CODEX_DISABLED_FEATURES } from './capabilities.js'
import { buildIsolationCommand } from './isolation.js'
import type { InteractiveProcessFactoryLike, InteractiveProcessLike } from './interactive-process.js'
import type {
  BrokerDecision,
  BrokerExecuteRequest,
  BrokerExecuteResponse,
  BrokerUsage,
  CliEffortLevel,
} from './protocol.js'
import { BROKER_PROTOCOL_VERSION, isClaudeCliModel, isCodexCliModel } from './protocol.js'
import { canonicalSystemPrompt, canonicalTurnPrompt, DECISION_JSON_SCHEMA } from './prompt.js'
import {
  hashesStartWith,
  sessionKey,
  transcriptHashes,
  transcriptWithDecision,
} from './session-correlation.js'
import { validateCliDecision } from '../providers/cli-request.js'
import {
  CliExecutionFailedError,
  CliTimeoutError,
  CliUnavailableError,
  InvalidCliOutputError,
} from '../providers/errors.js'
import { ClientAbortedError } from '../upstream/errors.js'
import { parseClaudeUsage, parseCodexUsage, UnexpectedCliToolEventError } from './executor.js'

interface SessionTurnResult {
  decision: BrokerDecision
  usage?: BrokerUsage
}

interface SessionHandle {
  readonly alive: boolean
  execute(prompt: string, effort: CliEffortLevel | undefined, signal?: AbortSignal): Promise<SessionTurnResult>
  close(): Promise<void>
}

interface MemorySession {
  key: string
  hashes: string[]
  lastUsedAt: number
  handle: SessionHandle
}

export interface MemorySessionExecutorLike {
  execute(
    request: BrokerExecuteRequest,
    transcriptBytes: number,
    signal?: AbortSignal,
  ): Promise<BrokerExecuteResponse>
  shutdown(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function objectAt(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key]
  return isRecord(value) ? value : undefined
}

function stringAt(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function parseDecision(value: unknown): BrokerDecision {
  if (!isRecord(value) || (typeof value.content !== 'string' && value.content !== null)) {
    throw new InvalidCliOutputError()
  }
  if (!Array.isArray(value.tool_calls)) throw new InvalidCliOutputError()
  return {
    content: value.content,
    toolCalls: value.tool_calls.map((call) => {
      if (!isRecord(call) || typeof call.name !== 'string' || typeof call.arguments !== 'string') {
        throw new InvalidCliOutputError()
      }
      return { name: call.name, arguments: call.arguments }
    }),
  }
}

function parseDecisionText(text: string): BrokerDecision {
  try {
    return parseDecision(JSON.parse(text))
  } catch (error) {
    if (error instanceof InvalidCliOutputError) throw error
    throw new InvalidCliOutputError()
  }
}

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new CliTimeoutError()
  return remaining
}

async function prepareWorkspace(config: BrokerConfig, prefix: string): Promise<string> {
  await mkdir(config.workRoot, { recursive: true, mode: 0o700 })
  await chmod(config.workRoot, 0o700)
  const workspace = await mkdtemp(join(config.workRoot, prefix))
  await chmod(workspace, 0o700)
  await writeFile(join(workspace, 'empty-mcp.json'), '{"mcpServers":{}}', { mode: 0o600 })
  await writeFile(
    join(workspace, 'claude-settings.json'),
    '{"hooks":{},"permissions":{"allow":[],"deny":[]}}',
    { mode: 0o600 },
  )
  return workspace
}

class CodexAppServerHost {
  private process: InteractiveProcessLike | undefined
  private workspace: string | undefined
  private nextRequestId = 1
  private starting: Promise<void> | undefined
  private readonly pendingNotifications: unknown[] = []

  constructor(
    private readonly config: BrokerConfig,
    private readonly capabilities: ProviderCapabilities,
    private readonly factory: InteractiveProcessFactoryLike,
  ) {}

  get alive(): boolean {
    return this.process !== undefined
  }

  async startThread(request: BrokerExecuteRequest): Promise<CodexThreadHandle> {
    if (!isCodexCliModel(request.model)) throw new CliUnavailableError()
    await this.ensureStarted()
    const result = await this.rpc('thread/start', {
      model: request.model,
      cwd: '/work',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      baseInstructions: canonicalSystemPrompt(request),
      developerInstructions: '',
      config: {
        approval_policy: 'never',
        shell_environment_policy: { inherit: 'none' },
        mcp_servers: {},
      },
    })
    const thread = isRecord(result) ? objectAt(result, 'thread') : undefined
    const threadId = thread === undefined ? undefined : stringAt(thread, 'id')
    if (threadId === undefined) throw new CliExecutionFailedError()
    return new CodexThreadHandle(this, threadId)
  }

  async turn(
    threadId: string,
    prompt: string,
    effort: CliEffortLevel | undefined,
    signal?: AbortSignal,
  ): Promise<SessionTurnResult> {
    if (effort === undefined) throw new CliUnavailableError()
    const process = this.requiredProcess()
    process.resetOutputBudget()
    const deadline = Date.now() + this.config.executionTimeoutMs
    const start = await this.rpc('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
      effort,
      approvalPolicy: 'never',
      cwd: '/work',
      outputSchema: DECISION_JSON_SCHEMA,
      sandboxPolicy: { type: 'readOnly' },
    }, signal, deadline)
    const turn = isRecord(start) ? objectAt(start, 'turn') : undefined
    const turnId = turn === undefined ? undefined : stringAt(turn, 'id')
    if (turnId === undefined) throw new CliExecutionFailedError()
    let usage: BrokerUsage | undefined
    let lastAgentMessageText: string | undefined
    try {
      for (;;) {
        const message = await this.readMessage(process, deadline, signal)
        if (!isRecord(message)) throw new CliExecutionFailedError()
        if ('id' in message && typeof message.method === 'string') throw new UnexpectedCliToolEventError()
        if (typeof message.method !== 'string') continue
        const params = objectAt(message, 'params')
        if (message.method === 'thread/tokenUsage/updated') {
          if (params !== undefined && params.turnId === turnId) {
            const tokenUsage = objectAt(params, 'tokenUsage')
            usage = parseCodexAppUsage(tokenUsage === undefined ? undefined : tokenUsage.last)
          }
          continue
        }
        if (message.method === 'item/started' || message.method === 'item/completed' || message.method === 'item/updated') {
          if (params !== undefined && params.turnId === turnId) {
            assertSafeCodexItem(params.item)
            const item = objectAt(params, 'item')
            if (
              message.method === 'item/completed' &&
              item !== undefined &&
              item.type === 'agentMessage' &&
              typeof item.text === 'string'
            ) {
              lastAgentMessageText = item.text
            }
          }
          continue
        }
        if (message.method === 'turn/completed') {
          if (params === undefined || params.threadId !== threadId) continue
          const completed = objectAt(params, 'turn')
          if (completed === undefined || completed.id !== turnId || completed.status !== 'completed') {
            throw new CliExecutionFailedError()
          }
          const decision = decisionFromCodexTurn(completed, lastAgentMessageText)
          return { decision, ...(usage === undefined ? {} : { usage }) }
        }
        if (message.method === 'error') throw new CliExecutionFailedError()
        assertBenignCodexNotification(message)
      }
    } catch (error) {
      if (error instanceof ClientAbortedError) await this.interrupt(threadId, turnId)
      else await this.close()
      throw error
    }
  }

  async removeThread(threadId: string): Promise<void> {
    if (!this.alive) return
    try {
      await this.rpc('thread/delete', { threadId })
    } catch {
      await this.close()
    }
  }

  async close(): Promise<void> {
    const process = this.process
    const workspace = this.workspace
    this.process = undefined
    this.workspace = undefined
    this.pendingNotifications.splice(0)
    if (process !== undefined) await process.terminate()
    if (workspace !== undefined) await rm(workspace, { recursive: true, force: true })
  }

  private async ensureStarted(): Promise<void> {
    if (this.process !== undefined) return
    if (this.starting !== undefined) return this.starting
    this.starting = this.startProcess()
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }

  private async startProcess(): Promise<void> {
    const capability = this.capabilities.codex
    if (!capability.available || !capability.binaryPath || !capability.authDir) throw new CliUnavailableError()
    const workspace = await prepareWorkspace(this.config, 'codex-app-server-')
    try {
      const ephemeralHome = join(workspace, 'codex-home')
      await mkdir(join(ephemeralHome, '.codex'), { recursive: true, mode: 0o700 })
      await writeFile(join(ephemeralHome, '.codex', 'auth.json'), '', { mode: 0o600 })
      const cliArgs = [
        'app-server',
        '--stdio',
        '--strict-config',
        '-c', 'approval_policy="never"',
        '-c', 'shell_environment_policy.inherit="none"',
        '-c', 'mcp_servers={}',
        ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
      ]
      const isolated = buildIsolationCommand(
        this.config,
        'codex',
        capability.binaryPath,
        capability.authDir,
        workspace,
        cliArgs,
        ephemeralHome,
        'codex-auth-file',
      )
      this.workspace = workspace
      this.process = this.factory.spawn({
        command: isolated.command,
        args: isolated.args,
        cwd: workspace,
        env: isolated.env,
        killGraceMs: this.config.killGraceMs,
        maxOutputBytes: this.config.maxOutputBytes,
      })
      await this.rpc('initialize', {
        clientInfo: { name: 'gateway-ai-broker', version: String(BROKER_PROTOCOL_VERSION) },
        capabilities: { experimentalApi: false },
      })
      this.requiredProcess().writeJson({ method: 'initialized', params: {} })
    } catch (error) {
      await this.close()
      throw error
    }
  }

  private async rpc(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    deadline = Date.now() + this.config.executionTimeoutMs,
  ): Promise<unknown> {
    const process = this.requiredProcess()
    const id = this.nextRequestId
    this.nextRequestId += 1
    process.writeJson({ id, method, params })
    const deferred: unknown[] = []
    for (;;) {
      const message = await process.readJson(remainingMs(deadline), signal)
      if (!isRecord(message)) throw new CliExecutionFailedError()
      if (message.id === id) {
        if ('error' in message) throw new CliExecutionFailedError()
        this.pendingNotifications.push(...deferred)
        return message.result
      }
      if ('id' in message && typeof message.method === 'string') throw new UnexpectedCliToolEventError()
      if (typeof message.method === 'string') assertBenignCodexNotification(message)
      deferred.push(message)
    }
  }

  private async interrupt(threadId: string, turnId: string): Promise<void> {
    try {
      await this.rpc('turn/interrupt', { threadId, turnId }, undefined, Date.now() + this.config.killGraceMs)
    } catch {
      await this.close()
    }
  }

  private requiredProcess(): InteractiveProcessLike {
    if (this.process === undefined) throw new CliExecutionFailedError()
    return this.process
  }

  private readMessage(
    process: InteractiveProcessLike,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const pending = this.pendingNotifications.shift()
    return pending === undefined
      ? process.readJson(remainingMs(deadline), signal)
      : Promise.resolve(pending)
  }
}

class CodexThreadHandle implements SessionHandle {
  private open = true

  constructor(private readonly host: CodexAppServerHost, private readonly threadId: string) {}

  get alive(): boolean {
    return this.open && this.host.alive
  }

  execute(prompt: string, effort: CliEffortLevel | undefined, signal?: AbortSignal): Promise<SessionTurnResult> {
    if (!this.alive) return Promise.reject(new CliExecutionFailedError())
    return this.host.turn(this.threadId, prompt, effort, signal)
  }

  async close(): Promise<void> {
    if (!this.open) return
    this.open = false
    await this.host.removeThread(this.threadId)
  }
}

class ClaudeSessionHandle implements SessionHandle {
  private open = true

  constructor(
    private readonly process: InteractiveProcessLike,
    private readonly workspace: string,
    private readonly config: BrokerConfig,
  ) {}

  get alive(): boolean {
    return this.open
  }

  async execute(prompt: string, _effort: CliEffortLevel | undefined, signal?: AbortSignal): Promise<SessionTurnResult> {
    if (!this.open) throw new CliExecutionFailedError()
    this.process.resetOutputBudget()
    this.process.writeJson({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
    })
    const deadline = Date.now() + this.config.executionTimeoutMs
    try {
      for (;;) {
        const value = await this.process.readJson(remainingMs(deadline), signal)
        if (!isRecord(value) || typeof value.type !== 'string') throw new CliExecutionFailedError()
        if (value.type === 'assistant') {
          assertSafeClaudeAssistant(value)
          continue
        }
        if (value.type === 'result') return parseClaudeStreamResult(value)
        if (value.type === 'system' || value.type === 'rate_limit_event') continue
        throw new UnexpectedCliToolEventError()
      }
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async close(): Promise<void> {
    if (!this.open) return
    this.open = false
    await this.process.terminate()
    await rm(this.workspace, { recursive: true, force: true })
  }
}

function isBenignCodexNotification(method: string): boolean {
  return [
    'thread/started',
    'thread/status/changed',
    'turn/started',
    'thread/deleted',
    'account/rateLimits/updated',
    'item/agentMessage/delta',
    'item/reasoning/summaryPartAdded',
    'item/reasoning/summaryTextDelta',
    'item/reasoning/textDelta',
    // Codex >= 0.144 emite status do remote control (sempre "disabled" aqui,
    // a feature está removed e não aceita --disable) e avisos textuais que não
    // representam execução local.
    'remoteControl/status/changed',
    'warning',
  ].includes(method)
}

function assertBenignCodexNotification(message: Record<string, unknown>): void {
  const method = typeof message.method === 'string' ? message.method : ''
  if (method === 'item/started' || method === 'item/completed' || method === 'item/updated') {
    const params = objectAt(message, 'params')
    if (params === undefined) throw new UnexpectedCliToolEventError()
    assertSafeCodexItem(params.item)
    return
  }
  if (!isBenignCodexNotification(method)) throw new UnexpectedCliToolEventError()
}

function assertSafeCodexItem(value: unknown): void {
  if (!isRecord(value) || typeof value.type !== 'string') throw new UnexpectedCliToolEventError()
  if (!['userMessage', 'agentMessage', 'reasoning'].includes(value.type)) {
    throw new UnexpectedCliToolEventError()
  }
}

function decisionFromCodexTurn(turn: Record<string, unknown>, fallbackText?: string): BrokerDecision {
  if (!Array.isArray(turn.items)) throw new InvalidCliOutputError()
  for (const item of turn.items) assertSafeCodexItem(item)
  const messages = turn.items.filter((item): item is Record<string, unknown> =>
    isRecord(item) && item.type === 'agentMessage' && typeof item.text === 'string')
  const last = messages.at(-1)
  if (last !== undefined && typeof last.text === 'string') return parseDecisionText(last.text)
  // Codex >= 0.144 envia turn/completed com items vazios (itemsView "notLoaded");
  // a decisão passa a vir do último item/completed agentMessage do turno.
  if (fallbackText !== undefined) return parseDecisionText(fallbackText)
  throw new InvalidCliOutputError()
}

export function parseCodexAppUsage(value: unknown): BrokerUsage | undefined {
  if (!isRecord(value)) return undefined
  return parseCodexUsage({
    input_tokens: value.inputTokens,
    cached_input_tokens: value.cachedInputTokens,
    output_tokens: value.outputTokens,
    reasoning_output_tokens: value.reasoningOutputTokens,
  })
}

function assertSafeClaudeAssistant(value: Record<string, unknown>): void {
  const message = objectAt(value, 'message')
  if (message === undefined || !Array.isArray(message.content)) throw new CliExecutionFailedError()
  for (const block of message.content) {
    if (
      !isRecord(block) ||
      (block.type !== 'text' && block.type !== 'thinking' && block.type !== 'redacted_thinking')
    ) {
      throw new UnexpectedCliToolEventError()
    }
  }
}

function parseClaudeStreamResult(value: Record<string, unknown>): SessionTurnResult {
  if (value.is_error === true || (typeof value.subtype === 'string' && value.subtype !== 'success')) {
    throw new CliExecutionFailedError()
  }
  if (Array.isArray(value.permission_denials) && value.permission_denials.length > 0) {
    throw new UnexpectedCliToolEventError()
  }
  let structured = value.structured_output
  if (structured === undefined && typeof value.result === 'string') {
    try {
      structured = JSON.parse(value.result)
    } catch {
      throw new InvalidCliOutputError()
    }
  }
  const decision = parseDecision(structured)
  const usage = parseClaudeUsage(value.usage, value.total_cost_usd)
  return { decision, ...(usage === undefined ? {} : { usage }) }
}

export class MemorySessionExecutor implements MemorySessionExecutorLike {
  private readonly sessions: MemorySession[] = []
  private readonly codexHost: CodexAppServerHost

  constructor(
    private readonly config: BrokerConfig,
    private readonly capabilities: ProviderCapabilities,
    private readonly factory: InteractiveProcessFactoryLike,
    private readonly now: () => number = Date.now,
  ) {
    this.codexHost = new CodexAppServerHost(config, capabilities, factory)
  }

  async execute(
    request: BrokerExecuteRequest,
    transcriptBytes: number,
    signal?: AbortSignal,
  ): Promise<BrokerExecuteResponse> {
    await this.purgeExpired()
    const key = sessionKey(request)
    const hashes = transcriptHashes(request.messages)
    const matches = this.sessions.filter((session) =>
      session.key === key && session.handle.alive && hashesStartWith(hashes, session.hashes))
    const reused = matches.length === 1
    let session = reused ? matches[0] : undefined
    const deltaStart = session?.hashes.length ?? 0
    if (session === undefined) {
      await this.ensureCapacity()
      session = {
        key,
        hashes: [],
        lastUsedAt: this.now(),
        handle: await this.createHandle(request),
      }
      this.sessions.push(session)
    }
    const turnRequest: BrokerExecuteRequest = {
      ...request,
      messages: request.messages.slice(deltaStart),
    }
    try {
      const result = await session.handle.execute(canonicalTurnPrompt(turnRequest), request.effort, signal)
      const decision = validateCliDecision(result.decision, request)
      session.hashes = transcriptHashes(transcriptWithDecision(request.messages, decision))
      session.lastUsedAt = this.now()
      return {
        version: BROKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        decision,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        execution: { sessionMode: 'memory', sessionReused: reused, transcriptBytes },
      }
    } catch (error) {
      await this.removeSession(session)
      throw error
    }
  }

  async shutdown(): Promise<void> {
    const current = this.sessions.splice(0)
    for (const session of current) {
      try {
        await session.handle.close()
      } catch {
        // O shutdown ainda precisa encerrar o host e remover os demais workspaces.
      }
    }
    await this.codexHost.close()
  }

  private async createHandle(request: BrokerExecuteRequest): Promise<SessionHandle> {
    if (request.provider === 'codex') return this.codexHost.startThread(request)
    if (!isClaudeCliModel(request.model)) throw new CliUnavailableError()
    const capability = this.capabilities.claude
    if (!capability.available || !capability.binaryPath || !capability.authDir || !capability.configPath) {
      throw new CliUnavailableError()
    }
    const workspace = await prepareWorkspace(this.config, 'claude-session-')
    try {
      const ephemeralHome = join(workspace, 'claude-home')
      await mkdir(join(ephemeralHome, '.claude'), { recursive: true, mode: 0o700 })
      await writeFile(join(ephemeralHome, '.claude', '.credentials.json'), '', { mode: 0o600 })
      await copyFile(capability.configPath, join(ephemeralHome, '.claude.json'))
      await chmod(join(ephemeralHome, '.claude.json'), 0o600)
      const args = [
        '--print',
        '--prompt-suggestions', 'false',
        '--model', request.model,
        ...(request.effort === undefined ? [] : ['--effort', request.effort]),
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--json-schema', JSON.stringify(DECISION_JSON_SCHEMA),
        '--tools', '',
        '--strict-mcp-config',
        '--mcp-config', '/work/empty-mcp.json',
        '--disable-slash-commands',
        '--no-chrome',
        '--no-session-persistence',
        '--safe-mode',
        '--setting-sources', '',
        '--settings', '/work/claude-settings.json',
        '--permission-mode', 'dontAsk',
        '--agents', '{}',
        '--system-prompt', canonicalSystemPrompt(request),
      ]
      const isolated = buildIsolationCommand(
        this.config,
        'claude',
        capability.binaryPath,
        capability.authDir,
        workspace,
        args,
        ephemeralHome,
        'claude-auth-file',
      )
      const process = this.factory.spawn({
        command: isolated.command,
        args: isolated.args,
        cwd: workspace,
        env: isolated.env,
        killGraceMs: this.config.killGraceMs,
        maxOutputBytes: this.config.maxOutputBytes,
      })
      return new ClaudeSessionHandle(process, workspace, this.config)
    } catch (error) {
      await rm(workspace, { recursive: true, force: true })
      throw error
    }
  }

  private async ensureCapacity(): Promise<void> {
    while (this.sessions.length >= this.config.maxActiveSessions) {
      const oldest = [...this.sessions].sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0]
      if (oldest === undefined) return
      await this.removeSession(oldest)
    }
  }

  private async purgeExpired(): Promise<void> {
    const cutoff = this.now() - this.config.sessionIdleMs
    const expired = this.sessions.filter((session) => !session.handle.alive || session.lastUsedAt <= cutoff)
    for (const session of expired) await this.removeSession(session)
  }

  private async removeSession(session: MemorySession): Promise<void> {
    const index = this.sessions.indexOf(session)
    if (index >= 0) this.sessions.splice(index, 1)
    await session.handle.close()
  }
}
