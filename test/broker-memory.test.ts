import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderCapabilities } from '../src/broker/capabilities.js'
import type { BrokerConfig } from '../src/broker/config.js'
import type {
  InteractiveProcessFactoryLike,
  InteractiveProcessLike,
  InteractiveProcessSpec,
} from '../src/broker/interactive-process.js'
import { InteractiveProcessFactory } from '../src/broker/interactive-process.js'
import { MemorySessionExecutor } from '../src/broker/memory-executor.js'
import { BROKER_PROTOCOL_VERSION, type BrokerExecuteRequest } from '../src/broker/protocol.js'
import { transcriptHashes } from '../src/broker/session-correlation.js'
import { CliExecutionFailedError, InvalidCliOutputError } from '../src/providers/errors.js'
import { ClientAbortedError } from '../src/upstream/errors.js'

const roots: string[] = []

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function setup(): { config: BrokerConfig; capabilities: ProviderCapabilities } {
  const root = mkdtempSync(join(tmpdir(), 'gateway-ai-memory-'))
  roots.push(root)
  const codexAuth = join(root, 'codex-auth')
  const claudeAuth = join(root, 'claude-auth')
  mkdirSync(codexAuth, { mode: 0o700 })
  mkdirSync(claudeAuth, { mode: 0o700 })
  writeFileSync(join(codexAuth, 'auth.json'), '{}', { mode: 0o600 })
  writeFileSync(join(claudeAuth, '.credentials.json'), '{}', { mode: 0o600 })
  const claudeConfigPath = join(root, '.claude.json')
  writeFileSync(claudeConfigPath, '{}', { mode: 0o600 })
  return {
    config: {
      socketPath: join(root, 'broker.sock'),
      workRoot: join(root, 'work'),
      enableCodex: true,
      enableClaude: true,
      executionTimeoutMs: 1000,
      killGraceMs: 20,
      maxOutputBytes: 1_048_576,
      maxRequestBytes: 1_048_576,
      maxTranscriptBytes: 262_144,
      codexSessionMode: 'memory',
      claudeSessionMode: 'memory',
      maxActiveSessions: 4,
      sessionIdleMs: 1_800_000,
      bwrapPath: process.execPath,
      codexPath: process.execPath,
      claudePath: process.execPath,
      codexAuthDir: codexAuth,
      claudeAuthDir: claudeAuth,
      claudeConfigPath,
    },
    capabilities: {
      codex: { available: true, binaryPath: process.execPath, authDir: codexAuth },
      claude: {
        available: true,
        binaryPath: process.execPath,
        authDir: claudeAuth,
        configPath: claudeConfigPath,
      },
    },
  }
}

function request(provider: 'codex' | 'claude', messages: BrokerExecuteRequest['messages']): BrokerExecuteRequest {
  return {
    version: BROKER_PROTOCOL_VERSION,
    requestId: `request-${provider}`,
    provider,
    model: provider === 'codex' ? 'gpt-5.4' : 'claude-sonnet-4-6',
    effort: 'medium',
    messages,
    tools: [],
    toolChoice: 'none',
    parallelToolCalls: false,
  }
}

class FakeInteractiveProcess implements InteractiveProcessLike {
  readonly writes: unknown[] = []
  readonly turnPrompts: string[] = []
  private readonly queue: unknown[] = []
  private threadSequence = 0
  private turnSequence = 0
  private open = true

  constructor(
    readonly provider: 'codex' | 'claude',
    private readonly codexStyle: 'legacy' | 'v0144' = 'legacy',
    private readonly extraTurnNotifications: unknown[] = [],
  ) {}

  private decision(prompt: string): { content: string | null; tool_calls: Array<{ name: string; arguments: string }> } {
    return prompt.includes('usar_tool')
      ? { content: null, tool_calls: [{ name: 'read_file', arguments: '{}' }] }
      : { content: 'ok', tool_calls: [] }
  }

  resetOutputBudget(): void {}

  writeJson(value: unknown): void {
    this.writes.push(value)
    if (!this.open || value === null || typeof value !== 'object' || Array.isArray(value)) return
    const message = value as Record<string, unknown>
    if (this.provider === 'claude') {
      if (message.type !== 'user') return
      const nested = message.message as Record<string, unknown>
      const prompt = String(nested.content)
      this.turnPrompts.push(prompt)
      this.queue.push(
        { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          structured_output: this.decision(prompt),
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 20,
            output_tokens: 3,
          },
          total_cost_usd: 0.01,
          permission_denials: [],
        },
      )
      return
    }
    if (message.method === 'initialize') {
      this.queue.push({ id: message.id, result: {} })
      return
    }
    if (message.method === 'thread/start') {
      this.threadSequence += 1
      if (this.codexStyle === 'v0144') {
        this.queue.push({
          method: 'remoteControl/status/changed',
          params: { status: 'disabled', serverName: 'host', installationId: 'id', environmentId: null },
        })
      }
      this.queue.push({ id: message.id, result: { thread: { id: `thread-${this.threadSequence}` } } })
      return
    }
    if (message.method === 'turn/start') {
      this.turnSequence += 1
      const params = message.params as Record<string, unknown>
      const input = params.input as Array<Record<string, unknown>>
      const prompt = String(input[0]?.text)
      this.turnPrompts.push(prompt)
      const turnId = `turn-${this.turnSequence}`
      this.queue.push({ id: message.id, result: { turn: { id: turnId } } })
      if (this.codexStyle === 'v0144') {
        this.queue.push(
          { method: 'warning', params: { threadId: params.threadId, message: 'aviso benigno' } },
          ...this.extraTurnNotifications,
          {
            method: 'item/completed',
            params: {
              threadId: params.threadId,
              turnId,
              item: { type: 'agentMessage', id: 'message-1', text: JSON.stringify(this.decision(prompt)) },
            },
          },
        )
      }
      this.queue.push(
        {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: params.threadId,
            turnId,
            tokenUsage: {
              last: {
                inputTokens: 30,
                cachedInputTokens: 20,
                outputTokens: 5,
                reasoningOutputTokens: 2,
                totalTokens: 35,
              },
            },
          },
        },
        {
          method: 'turn/completed',
          params: {
            threadId: params.threadId,
            turn: this.codexStyle === 'v0144'
              ? { id: turnId, status: 'completed', items: [], itemsView: 'notLoaded' }
              : {
                  id: turnId,
                  status: 'completed',
                  items: [{ type: 'agentMessage', id: 'message-1', text: JSON.stringify(this.decision(prompt)) }],
                },
          },
        },
      )
      return
    }
    if (message.method === 'thread/delete' || message.method === 'turn/interrupt') {
      this.queue.push({ id: message.id, result: {} })
    }
  }

  readJson(): Promise<unknown> {
    const value = this.queue.shift()
    return value === undefined
      ? Promise.reject(new CliExecutionFailedError())
      : Promise.resolve(value)
  }

  terminate(): Promise<void> {
    this.open = false
    return Promise.resolve()
  }
}

class FakeInteractiveFactory implements InteractiveProcessFactoryLike {
  readonly processes: FakeInteractiveProcess[] = []
  readonly specs: InteractiveProcessSpec[] = []

  constructor(
    private readonly codexStyle: 'legacy' | 'v0144' = 'legacy',
    private readonly extraTurnNotifications: unknown[] = [],
  ) {}

  spawn(spec: InteractiveProcessSpec): InteractiveProcessLike {
    this.specs.push(spec)
    const provider = spec.args.includes('app-server') ? 'codex' : 'claude'
    const process = new FakeInteractiveProcess(provider, this.codexStyle, this.extraTurnNotifications)
    this.processes.push(process)
    return process
  }
}

describe('sessões CLI em memória', () => {
  it('normaliza IDs de tool calls antes de correlacionar o transcript', () => {
    const left = transcriptHashes([
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call_a', name: 'read_file', arguments: '{}' }],
      },
      { role: 'tool', content: 'ok', toolCallId: 'call_a' },
    ])
    const right = transcriptHashes([
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'outro_id', name: 'read_file', arguments: '{}' }],
      },
      { role: 'tool', content: 'ok', toolCallId: 'outro_id' },
    ])
    expect(left).toEqual(right)
  })

  it('processo interativo usa JSONL, sem shell, e propaga cancelamento', async () => {
    const factory = new InteractiveProcessFactory()
    const processHandle = factory.spawn({
      command: process.execPath,
      args: ['-e', [
        'let b="";',
        'process.stdin.on("data",c=>{b+=c;let i;while((i=b.indexOf("\\n"))>=0){',
        'const l=b.slice(0,i);b=b.slice(i+1);if(l)process.stdout.write(l+"\\n");}});',
      ].join('')],
      cwd: '/tmp',
      env: { PATH: '/usr/bin:/bin' },
      killGraceMs: 20,
      maxOutputBytes: 1024,
    })
    processHandle.writeJson({ ok: true })
    await expect(processHandle.readJson(1000)).resolves.toEqual({ ok: true })
    const controller = new AbortController()
    controller.abort()
    await expect(processHandle.readJson(1000, controller.signal)).rejects.toBeInstanceOf(ClientAbortedError)
    await processHandle.terminate()
  })

  it('reutiliza uma thread Codex somente com prefixo exato e envia apenas o delta', async () => {
    const { config, capabilities } = setup()
    const factory = new FakeInteractiveFactory()
    const executor = new MemorySessionExecutor(config, capabilities, factory)
    const first = await executor.execute(request('codex', [{ role: 'user', content: 'primeiro' }]), 10)
    const second = await executor.execute(request('codex', [
      { role: 'user', content: 'primeiro' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'segundo' },
    ]), 20)

    expect(first.execution).toMatchObject({ sessionMode: 'memory', sessionReused: false })
    expect(second.execution).toMatchObject({ sessionMode: 'memory', sessionReused: true })
    expect(second.usage).toMatchObject({
      promptTokens: 30,
      freshInputTokens: 10,
      cachedInputTokens: 20,
      completionTokens: 5,
      reasoningOutputTokens: 2,
      totalTokens: 35,
    })
    expect(factory.processes).toHaveLength(1)
    expect(factory.processes[0]?.turnPrompts[0]).toContain('primeiro')
    expect(factory.processes[0]?.turnPrompts[1]).not.toContain('primeiro')
    expect(factory.processes[0]?.turnPrompts[1]).toContain('segundo')
    await executor.shutdown()
  })

  it('aceita o protocolo do codex 0.144: decisão via item/completed e notificações novas', async () => {
    const { config, capabilities } = setup()
    const factory = new FakeInteractiveFactory('v0144')
    const executor = new MemorySessionExecutor(config, capabilities, factory)
    const first = await executor.execute(request('codex', [{ role: 'user', content: 'primeiro' }]), 10)
    const second = await executor.execute(request('codex', [
      { role: 'user', content: 'primeiro' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'segundo' },
    ]), 20)

    expect(first.decision).toEqual({ content: 'ok', toolCalls: [] })
    expect(first.execution.sessionReused).toBe(false)
    expect(second.execution.sessionReused).toBe(true)
    expect(second.usage).toMatchObject({ promptTokens: 30, completionTokens: 5, totalTokens: 35 })
    expect(factory.processes).toHaveLength(1)
    await executor.shutdown()
  })

  it('continua encerrando a sessão quando o app-server emite evento MCP', async () => {
    const { config, capabilities } = setup()
    const factory = new FakeInteractiveFactory('v0144', [{
      method: 'mcpServer/startupStatus/updated',
      params: { threadId: 'thread-1', name: 'codex_apps', status: 'starting', error: null },
    }])
    const executor = new MemorySessionExecutor(config, capabilities, factory)
    await expect(executor.execute(request('codex', [{ role: 'user', content: 'primeiro' }]), 10))
      .rejects.toBeInstanceOf(InvalidCliOutputError)
    await executor.shutdown()
  })

  it('reutiliza processo Claude e contabiliza criação e leitura de cache no input lógico', async () => {
    const { config, capabilities } = setup()
    const factory = new FakeInteractiveFactory()
    const executor = new MemorySessionExecutor(config, capabilities, factory)
    await executor.execute(request('claude', [{ role: 'user', content: 'primeiro' }]), 10)
    const second = await executor.execute(request('claude', [
      { role: 'user', content: 'primeiro' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'segundo' },
    ]), 20)

    expect(second.execution.sessionReused).toBe(true)
    expect(second.usage).toEqual({
      promptTokens: 32,
      completionTokens: 3,
      totalTokens: 35,
      freshInputTokens: 2,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 20,
      estimatedCostUsd: 0.01,
    })
    expect(factory.processes).toHaveLength(1)
    expect(factory.specs[0]?.args).toContain('--input-format')
    expect(factory.specs[0]?.args).toContain('stream-json')
    expect(factory.processes[0]?.turnPrompts[1]).not.toContain('primeiro')
    await executor.shutdown()
  })

  it('reutiliza sessão no fluxo tool call -> tool result com ID normalizado', async () => {
    const { config, capabilities } = setup()
    const factory = new FakeInteractiveFactory()
    const executor = new MemorySessionExecutor(config, capabilities, factory)
    const firstRequest = request('codex', [{ role: 'user', content: 'usar_tool' }])
    firstRequest.tools = [{ name: 'read_file', parameters: {} }]
    firstRequest.toolChoice = 'auto'
    const first = await executor.execute(firstRequest, 10)
    expect(first.decision.toolCalls).toEqual([{ name: 'read_file', arguments: '{}' }])

    const secondRequest = request('codex', [
      { role: 'user', content: 'usar_tool' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call_gerado_pelo_gateway', name: 'read_file', arguments: '{}' }],
      },
      { role: 'tool', content: 'resultado', toolCallId: 'call_gerado_pelo_gateway' },
    ])
    secondRequest.tools = [{ name: 'read_file', parameters: {} }]
    secondRequest.toolChoice = 'auto'
    const second = await executor.execute(secondRequest, 20)
    expect(second.execution.sessionReused).toBe(true)
    expect(second.decision.content).toBe('ok')
    expect(factory.processes[0]?.turnPrompts[1]).toContain('resultado')
    expect(factory.processes[0]?.turnPrompts[1]).not.toContain('usar_tool')
    await executor.shutdown()
  })

  it('não reutiliza sessão após divergência de transcript', async () => {
    const { config, capabilities } = setup()
    const factory = new FakeInteractiveFactory()
    const executor = new MemorySessionExecutor(config, capabilities, factory)
    await executor.execute(request('claude', [{ role: 'user', content: 'ramo A' }]), 10)
    const divergent = await executor.execute(request('claude', [{ role: 'user', content: 'ramo B' }]), 10)
    expect(divergent.execution.sessionReused).toBe(false)
    expect(factory.processes).toHaveLength(2)
    await executor.shutdown()
  })

  it('não reutiliza quando mais de uma sessão possui o mesmo prefixo', async () => {
    const { config, capabilities } = setup()
    const factory = new FakeInteractiveFactory()
    const executor = new MemorySessionExecutor(config, capabilities, factory)
    const initial = request('claude', [{ role: 'user', content: 'igual' }])
    await executor.execute(initial, 10)
    await executor.execute({ ...initial, requestId: 'duplicada' }, 10)
    const ambiguous = await executor.execute(request('claude', [
      { role: 'user', content: 'igual' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'continue' },
    ]), 20)
    expect(ambiguous.execution.sessionReused).toBe(false)
    expect(factory.processes).toHaveLength(3)
    await executor.shutdown()
  })

  it('preserva thread Codex ao mudar effort e reinicia Claude', async () => {
    const { config, capabilities } = setup()
    const factory = new FakeInteractiveFactory()
    const executor = new MemorySessionExecutor(config, capabilities, factory)
    const codexFirst = request('codex', [{ role: 'user', content: 'codex' }])
    await executor.execute(codexFirst, 10)
    const codexSecond = request('codex', [
      { role: 'user', content: 'codex' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'continue' },
    ])
    codexSecond.effort = 'high'
    expect((await executor.execute(codexSecond, 20)).execution.sessionReused).toBe(true)

    const claudeFirst = request('claude', [{ role: 'user', content: 'claude' }])
    await executor.execute(claudeFirst, 10)
    const claudeSecond = request('claude', [
      { role: 'user', content: 'claude' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'continue' },
    ])
    claudeSecond.effort = 'high'
    expect((await executor.execute(claudeSecond, 20)).execution.sessionReused).toBe(false)
    await executor.shutdown()
  })

  it('aplica LRU global sem manter sessões acima do limite', async () => {
    const { config, capabilities } = setup()
    config.maxActiveSessions = 1
    const factory = new FakeInteractiveFactory()
    const executor = new MemorySessionExecutor(config, capabilities, factory)
    await executor.execute(request('claude', [{ role: 'user', content: 'A' }]), 10)
    await executor.execute(request('claude', [{ role: 'user', content: 'B' }]), 10)
    const afterEviction = await executor.execute(request('claude', [
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'retomar' },
    ]), 20)
    expect(afterEviction.execution.sessionReused).toBe(false)
    expect(factory.processes).toHaveLength(3)
    await executor.shutdown()
  })

  it('remove sessão ociosa ao ultrapassar o TTL', async () => {
    const { config, capabilities } = setup()
    config.sessionIdleMs = 1000
    let now = 0
    const factory = new FakeInteractiveFactory()
    const executor = new MemorySessionExecutor(config, capabilities, factory, () => now)
    await executor.execute(request('claude', [{ role: 'user', content: 'A' }]), 10)
    now = 1001
    const afterTtl = await executor.execute(request('claude', [
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'retomar' },
    ]), 20)
    expect(afterTtl.execution.sessionReused).toBe(false)
    expect(factory.processes).toHaveLength(2)
    await executor.shutdown()
  })
})
