import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderCapabilities } from '../src/broker/capabilities.js'
import type { BrokerConfig } from '../src/broker/config.js'
import {
  BrokerExecutor,
  CliEventProtocolError,
  CliFinalSchemaError,
  CliOutputLimitError,
  CliProcessExitError,
  CliTurnFailedError,
  parseClaudeUsage,
  parseCodexUsage,
  UnexpectedCliToolEventError,
} from '../src/broker/executor.js'
import { ProcessRunner, type ProcessRunResult, type ProcessRunnerLike, type ProcessRunSpec } from '../src/broker/process-runner.js'
import {
  BROKER_PROTOCOL_VERSION,
  type BrokerExecuteRequest,
  type ClaudeCliModel,
  type CliEffortLevel,
} from '../src/broker/protocol.js'
import { createBrokerServer, listenBroker } from '../src/broker/server.js'
import { CliBrokerClient } from '../src/providers/broker-client.js'
import {
  CliBusyError,
  CliContextTooLargeError,
  CliExecutionFailedError,
  CliTimeoutError,
  CliUnavailableError,
  InvalidCliOutputError,
} from '../src/providers/errors.js'
import { ClientAbortedError } from '../src/upstream/errors.js'

const directories: string[] = []
const servers: ReturnType<typeof createBrokerServer>[] = []

function directory(): string {
  const result = mkdtempSync(join(tmpdir(), 'azigate-broker-test-'))
  directories.push(result)
  return result
}

function config(root: string): BrokerConfig {
  const auth = join(root, 'auth')
  const work = join(root, 'work')
  const socketDirectory = join(root, 'socket')
  const claudeConfigPath = join(root, '.claude.json')
  const executable = process.execPath
  mkdirSync(auth, { mode: 0o700 })
  writeFileSync(claudeConfigPath, '{"preservado":true}', { mode: 0o600 })
  return {
    socketPath: join(socketDirectory, 'broker.sock'),
    workRoot: work,
    enableCodex: true,
    enableClaude: false,
    executionTimeoutMs: 1000,
    killGraceMs: 20,
    maxOutputBytes: 1_048_576,
    maxRequestBytes: 1_048_576,
    maxTranscriptBytes: 262_144,
    codexSessionMode: 'stateless',
    claudeSessionMode: 'stateless',
    maxActiveSessions: 4,
    sessionIdleMs: 1_800_000,
    bwrapPath: executable,
    codexPath: executable,
    claudePath: executable,
    codexAuthDir: auth,
    claudeAuthDir: auth,
    claudeConfigPath,
  }
}

const capabilities: ProviderCapabilities = {
  codex: { available: true, binaryPath: process.execPath, authDir: '/tmp' },
  claude: { available: false, code: 'disabled' },
}

function brokerRequest(): BrokerExecuteRequest {
  return {
    version: BROKER_PROTOCOL_VERSION,
    requestId: 'request-1',
    provider: 'codex',
    model: 'gpt-5.4',
    effort: 'medium',
    messages: [{ role: 'user', content: 'Responda texto' }],
    tools: [],
    toolChoice: 'none',
    parallelToolCalls: false,
  }
}

function claudeBrokerRequest(
  effort?: CliEffortLevel,
  model: ClaudeCliModel = 'claude-sonnet-4-6',
): BrokerExecuteRequest {
  const base = brokerRequest()
  delete base.effort
  return {
    ...base,
    provider: 'claude',
    model,
    ...(effort === undefined ? {} : { effort }),
  }
}

function completed(stdout = ''): ProcessRunResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: stdout || [
      JSON.stringify({ type: 'thread.started' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } }),
    ].join('\n'),
    stderr: '',
    timedOut: false,
    aborted: false,
    outputExceeded: false,
  }
}

class FakeRunner implements ProcessRunnerLike {
  readonly calls: ProcessRunSpec[] = []

  async run(spec: ProcessRunSpec): Promise<ProcessRunResult> {
    this.calls.push(spec)
    writeFileSync(join(spec.cwd, 'final.json'), '{"content":"ok","tool_calls":[]}')
    return completed()
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async ({ server, controller }) => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    await Promise.all([controller.shutdown(), closed])
  }))
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})

describe('broker local', () => {
  it('contabiliza usage por provider sem somar subconjuntos duas vezes', () => {
    expect(parseClaudeUsage({
      input_tokens: 2,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 900,
      output_tokens: 10,
    }, 0.25)).toEqual({
      promptTokens: 1002,
      completionTokens: 10,
      totalTokens: 1012,
      freshInputTokens: 2,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 900,
      estimatedCostUsd: 0.25,
    })
    expect(parseCodexUsage({
      input_tokens: 1000,
      cached_input_tokens: 900,
      output_tokens: 100,
      reasoning_output_tokens: 80,
    })).toEqual({
      promptTokens: 1000,
      completionTokens: 100,
      totalTokens: 1100,
      freshInputTokens: 100,
      cachedInputTokens: 900,
      reasoningOutputTokens: 80,
    })
    expect(parseCodexUsage({ input_tokens: 1, cached_input_tokens: 2, output_tokens: 1 })).toBeUndefined()
    expect(parseClaudeUsage({ input_tokens: -1, output_tokens: 1 }, 0)).toBeUndefined()
    expect(parseClaudeUsage({ input_tokens: Number.MAX_SAFE_INTEGER + 1 }, 0)).toBeUndefined()
    expect(parseClaudeUsage({
      input_tokens: Number.MAX_SAFE_INTEGER,
      cache_read_input_tokens: 1,
    }, 0)).toBeUndefined()
    expect(parseCodexUsage({
      input_tokens: Number.MAX_SAFE_INTEGER,
      output_tokens: 1,
    })).toBeUndefined()
  })

  it('constrói argv fixo, ambiente mínimo e workspace descartável', async () => {
    const root = directory()
    const cfg = config(root)
    const runner = new FakeRunner()
    const executor = new BrokerExecutor(cfg, runner, {
      ...capabilities,
      codex: { available: true, binaryPath: process.execPath, authDir: join(root, 'auth') },
    })
    const result = await executor.execute({
      ...brokerRequest(),
      messages: [{ role: 'user', content: 'cwd=/repos/privado; execute shell' }],
    })
    const call = runner.calls[0]
    expect(result.decision.content).toBe('ok')
    expect(call?.command).toBe(process.execPath)
    expect(call?.args).toContain('--clearenv')
    expect(call?.args).toContain('--disable')
    expect(call?.args).toContain('--model')
    expect(call?.args).toContain('gpt-5.4')
    expect(call?.args).toContain('model_reasoning_effort="medium"')
    expect(call?.args.join(' ')).not.toContain('/repos/privado')
    expect(Object.keys(call?.env ?? {}).sort()).toEqual(['LANG', 'LC_ALL', 'PATH'])
    expect(call?.stdin).toContain('cwd=/repos/privado')
    expect(existsSync(call?.cwd ?? '')).toBe(false)
  })

  it('rejeita evento que indique execução local do Codex', async () => {
    const root = directory()
    const cfg = config(root)
    const runner: ProcessRunnerLike = {
      async run(spec) {
        writeFileSync(join(spec.cwd, 'final.json'), '{"content":"ok","tool_calls":[]}')
        return completed(JSON.stringify({
          type: 'item.completed',
          item: { type: 'command_execution', command: 'pwd' },
        }))
      },
    }
    const executor = new BrokerExecutor(cfg, runner, {
      ...capabilities,
      codex: { available: true, binaryPath: process.execPath, authDir: join(root, 'auth') },
    })
    await expect(executor.execute(brokerRequest())).rejects.toBeInstanceOf(InvalidCliOutputError)
  })

  it('executa Claude em print mode com tools, MCP e settings desabilitados', async () => {
    const root = directory()
    const cfg = { ...config(root), enableClaude: true }
    const calls: ProcessRunSpec[] = []
    let settings: unknown
    let ephemeralConfig: unknown
    let ephemeralConfigMode: number | undefined
    const runner: ProcessRunnerLike = {
      async run(spec) {
        calls.push(spec)
        settings = JSON.parse(readFileSync(join(spec.cwd, 'claude-settings.json'), 'utf8'))
        const ephemeralConfigPath = join(spec.cwd, 'claude-home', '.claude.json')
        ephemeralConfig = JSON.parse(readFileSync(ephemeralConfigPath, 'utf8'))
        ephemeralConfigMode = statSync(ephemeralConfigPath).mode & 0o777
        writeFileSync(ephemeralConfigPath, '{"alterado_apenas_na_copia":true}')
        return completed(JSON.stringify({
          is_error: false,
          structured_output: { content: 'ok claude', tool_calls: [] },
          usage: { input_tokens: 2, output_tokens: 1 },
          permission_denials: [],
        }))
      },
    }
    const executor = new BrokerExecutor(cfg, runner, {
      codex: { available: false, code: 'disabled' },
      claude: {
        available: true,
        binaryPath: process.execPath,
        authDir: join(root, 'auth'),
        configPath: cfg.claudeConfigPath,
      },
    })
    const result = await executor.execute(claudeBrokerRequest('xhigh', 'claude-opus-4-8'))
    const args = calls[0]?.args ?? []
    expect(result.decision.content).toBe('ok claude')
    expect(args).toContain('--print')
    expect(args[args.indexOf('--prompt-suggestions') + 1]).toBe('false')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--disable-slash-commands')
    expect(args).toContain('--no-session-persistence')
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-8')
    expect(args[args.indexOf('--effort') + 1]).toBe('xhigh')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    const settingsPath = calls[0]?.args[args.indexOf('--settings') + 1]
    expect(settingsPath).toBe('/work/claude-settings.json')
    expect(settings).toEqual({
      hooks: {},
      permissions: { allow: [], deny: [] },
    })
    expect(ephemeralConfig).toEqual({ preservado: true })
    expect(ephemeralConfigMode).toBe(0o600)
    expect(readFileSync(cfg.claudeConfigPath, 'utf8')).toBe('{"preservado":true}')
    expect(args).not.toContain(cfg.claudeConfigPath)
  })

  it('não adiciona --effort quando o pedido normalizado não possui effort', async () => {
    const root = directory()
    const calls: ProcessRunSpec[] = []
    const runner: ProcessRunnerLike = {
      async run(spec) {
        calls.push(spec)
        return completed(JSON.stringify({ content: 'ok', tool_calls: [] }))
      },
    }
    const executor = new BrokerExecutor({ ...config(root), enableClaude: true }, runner, {
      codex: { available: false, code: 'disabled' },
      claude: {
        available: true,
        binaryPath: process.execPath,
        authDir: join(root, 'auth'),
        configPath: join(root, '.claude.json'),
      },
    })
    await executor.execute(claudeBrokerRequest(undefined, 'claude-haiku-4-5'))
    const args = calls[0]?.args ?? []
    expect(args).not.toContain('--effort')
    expect(args[args.indexOf('--model') + 1]).toBe('claude-haiku-4-5')
  })

  it('falha imediatamente quando a capacidade do provider está indisponível', async () => {
    const root = directory()
    const executor = new BrokerExecutor(config(root), new FakeRunner(), {
      codex: { available: false, code: 'not_authenticated' },
      claude: { available: false, code: 'disabled' },
    })
    await expect(executor.execute(brokerRequest())).rejects.toBeInstanceOf(CliUnavailableError)
  })

  it('rejeita transcript acima do limite antes de criar subprocesso', async () => {
    const root = directory()
    const runner = new FakeRunner()
    const executor = new BrokerExecutor({ ...config(root), maxTranscriptBytes: 1024 }, runner, {
      ...capabilities,
      codex: { available: true, binaryPath: process.execPath, authDir: join(root, 'auth') },
    })
    await expect(executor.execute({
      ...brokerRequest(),
      messages: [{ role: 'user', content: 'x'.repeat(2000) }],
    })).rejects.toBeInstanceOf(CliContextTooLargeError)
    expect(runner.calls).toHaveLength(0)
  })

  it.each([
    ['timeout', { timedOut: true }, CliTimeoutError],
    ['cancelamento', { aborted: true }, ClientAbortedError],
    ['limite de saída', { outputExceeded: true }, CliOutputLimitError],
  ] as const)('mapeia %s do subprocesso', async (_name, overrides, ErrorType) => {
    const root = directory()
    const runner: ProcessRunnerLike = {
      async run() {
        return { ...completed(), ...overrides }
      },
    }
    const executor = new BrokerExecutor(config(root), runner, {
      ...capabilities,
      codex: { available: true, binaryPath: process.execPath, authDir: join(root, 'auth') },
    })
    await expect(executor.execute(brokerRequest())).rejects.toBeInstanceOf(ErrorType)
  })

  it('classifica exit code sem publicar stderr', async () => {
    const root = directory()
    const runner: ProcessRunnerLike = {
      async run() {
        return { ...completed(), exitCode: 1, stderr: 'bwrap: falha controlada' }
      },
    }
    const executor = new BrokerExecutor(config(root), runner, {
      ...capabilities,
      codex: { available: true, binaryPath: process.execPath, authDir: join(root, 'auth') },
    })
    await expect(executor.execute(brokerRequest())).rejects.toMatchObject({
      name: 'CliProcessExitError_1_bwrap',
    })
    expect(new CliProcessExitError(null, 'unknown')).toBeInstanceOf(CliExecutionFailedError)
  })

  it('classifica rate limit estruturado do Claude sem publicar sua saída', async () => {
    const root = directory()
    const runner: ProcessRunnerLike = {
      async run() {
        return {
          ...completed(JSON.stringify({ is_error: true, api_error_status: 429, result: 'rate limit' })),
          exitCode: 1,
        }
      },
    }
    const executor = new BrokerExecutor(config(root), runner, {
      codex: { available: false, code: 'disabled' },
      claude: {
        available: true,
        binaryPath: process.execPath,
        authDir: join(root, 'auth'),
        configPath: join(root, '.claude.json'),
      },
    })
    await expect(executor.execute(claudeBrokerRequest())).rejects.toMatchObject({
      name: 'CliProcessExitError_1_rate_limit',
    })
  })

  it.each([
    ['json inválido', 'não-json', CliEventProtocolError],
    ['evento sem type', '{}', CliEventProtocolError],
    ['evento desconhecido', '{"type":"thread.unknown"}', CliEventProtocolError],
    ['turn failed', '{"type":"turn.failed","error":{"message":"network request failed"}}', CliTurnFailedError],
  ] as const)('rejeita JSONL Codex: %s', async (_name, stdout, ErrorType) => {
    const root = directory()
    const runner: ProcessRunnerLike = {
      async run(spec) {
        writeFileSync(join(spec.cwd, 'final.json'), '{"content":"ok","tool_calls":[]}')
        return completed(stdout)
      },
    }
    const executor = new BrokerExecutor(config(root), runner, {
      ...capabilities,
      codex: { available: true, binaryPath: process.execPath, authDir: join(root, 'auth') },
    })
    await expect(executor.execute(brokerRequest())).rejects.toBeInstanceOf(ErrorType)
  })

  it.each([
    ['json final inválido', 'não-json'],
    ['shape final inválido', '{"content":42,"tool_calls":[]}'],
    ['tool call final inválida', '{"content":null,"tool_calls":[{"name":42,"arguments":"{}"}]}'],
  ])('rejeita %s do Codex', async (_name, final) => {
    const root = directory()
    const runner: ProcessRunnerLike = {
      async run(spec) {
        writeFileSync(join(spec.cwd, 'final.json'), final)
        return completed()
      },
    }
    const executor = new BrokerExecutor(config(root), runner, {
      ...capabilities,
      codex: { available: true, binaryPath: process.execPath, authDir: join(root, 'auth') },
    })
    await expect(executor.execute(brokerRequest())).rejects.toBeInstanceOf(CliFinalSchemaError)
  })

  it('rejeita arquivo final acima do limite', async () => {
    const root = directory()
    const cfg = { ...config(root), maxOutputBytes: 10 }
    const runner: ProcessRunnerLike = {
      async run(spec) {
        writeFileSync(join(spec.cwd, 'final.json'), '{"content":"texto longo","tool_calls":[]}')
        return completed()
      },
    }
    const executor = new BrokerExecutor(cfg, runner, {
      ...capabilities,
      codex: { available: true, binaryPath: process.execPath, authDir: join(root, 'auth') },
    })
    await expect(executor.execute(brokerRequest())).rejects.toBeInstanceOf(CliFinalSchemaError)
  })

  it('aceita result JSON string e decisão direta do Claude', async () => {
    const root = directory()
    const outputs = [
      JSON.stringify({ result: '{"content":"via result","tool_calls":[]}', usage: { input_tokens: 2 } }),
      JSON.stringify({ content: 'direto', tool_calls: [], usage: { output_tokens: 1 } }),
    ]
    const runner: ProcessRunnerLike = {
      async run() {
        return completed(outputs.shift() ?? '{}')
      },
    }
    const executor = new BrokerExecutor(config(root), runner, {
      codex: { available: false, code: 'disabled' },
      claude: {
        available: true,
        binaryPath: process.execPath,
        authDir: join(root, 'auth'),
        configPath: join(root, '.claude.json'),
      },
    })
    await expect(executor.execute(claudeBrokerRequest())).resolves.toMatchObject({
      decision: { content: 'via result' },
      usage: { promptTokens: 2 },
    })
    await expect(executor.execute({ ...claudeBrokerRequest(), requestId: 'request-2' })).resolves.toMatchObject({
      decision: { content: 'direto' },
      usage: { completionTokens: 1 },
    })
  })

  it.each([
    ['stdout inválido', 'não-json', CliFinalSchemaError],
    ['result inválido', '{"result":"não-json"}', CliFinalSchemaError],
    ['erro declarado', '{"is_error":true}', CliExecutionFailedError],
    ['permission denial', '{"permission_denials":[{"tool":"Read"}]}', UnexpectedCliToolEventError],
  ] as const)('rejeita saída Claude: %s', async (_name, stdout, ErrorType) => {
    const root = directory()
    const runner: ProcessRunnerLike = { run: async () => completed(stdout) }
    const executor = new BrokerExecutor(config(root), runner, {
      codex: { available: false, code: 'disabled' },
      claude: {
        available: true,
        binaryPath: process.execPath,
        authDir: join(root, 'auth'),
        configPath: join(root, '.claude.json'),
      },
    })
    await expect(executor.execute(claudeBrokerRequest())).rejects.toBeInstanceOf(ErrorType)
  })

  it('ProcessRunner limita saída, aplica timeout e propaga cancelamento sem shell', async () => {
    const runner = new ProcessRunner()
    const base = {
      command: process.execPath,
      cwd: '/tmp',
      env: { PATH: '/usr/bin:/bin' },
      killGraceMs: 10,
    }
    const large = await runner.run({
      ...base,
      args: ['-e', 'process.stdout.write("x".repeat(200000))'],
      timeoutMs: 1000,
      maxOutputBytes: 1000,
    })
    expect(large.outputExceeded).toBe(true)

    const timed = await runner.run({
      ...base,
      args: ['-e', 'setInterval(()=>{},1000)'],
      timeoutMs: 30,
      maxOutputBytes: 1000,
    })
    expect(timed.timedOut).toBe(true)

    const abort = new AbortController()
    setTimeout(() => abort.abort(), 20)
    const cancelled = await runner.run({
      ...base,
      args: ['-e', 'setInterval(()=>{},1000)'],
      timeoutMs: 1000,
      maxOutputBytes: 1000,
      signal: abort.signal,
    })
    expect(cancelled.aborted).toBe(true)
  })

  it('integra gateway e broker por Unix socket privado', async () => {
    const root = directory()
    const cfg = config(root)
    const runner = new FakeRunner()
    const instance = createBrokerServer(cfg, {
      ...capabilities,
      codex: { available: true, binaryPath: process.execPath, authDir: join(root, 'auth') },
    }, runner)
    servers.push(instance)
    await listenBroker(cfg, instance.server)
    expect(statSync(join(root, 'socket')).mode & 0o777).toBe(0o700)
    expect(statSync(cfg.socketPath).mode & 0o777).toBe(0o600)

    const client = new CliBrokerClient(cfg.socketPath, 1000)
    expect((await client.health()).providers.codex.available).toBe(true)
    expect((await client.execute(brokerRequest())).decision.content).toBe('ok')
  })

  it('fecha a superfície HTTP interna e expõe degradação sem detalhes sensíveis', async () => {
    const root = directory()
    const cfg = config(root)
    const instance = createBrokerServer(cfg, {
      codex: { available: false, code: 'not_authenticated' },
      claude: { available: false, code: 'disabled' },
    }, new FakeRunner())
    servers.push(instance)
    await listenBroker(cfg, instance.server)

    const call = async (path: string, method: 'GET' | 'POST', headers: Record<string, string> = {}) =>
      new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const request = httpRequest({ socketPath: cfg.socketPath, path, method, headers }, (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          }))
        })
        request.once('error', reject)
        request.end()
      })

    await expect(call('/health', 'GET')).resolves.toMatchObject({
      status: 200,
      body: { status: 'degraded' },
    })
    await expect(call('/nao-existe', 'GET')).resolves.toMatchObject({ status: 404 })
    await expect(call('/execute', 'POST')).resolves.toMatchObject({ status: 400 })
    await expect(call('/execute', 'POST', {
      'x-broker-protocol-version': String(BROKER_PROTOCOL_VERSION),
    })).resolves.toMatchObject({ status: 415 })
  })

  it('rejeita campo cwd no protocolo Unix antes do executor', async () => {
    const root = directory()
    const cfg = config(root)
    const runner = new FakeRunner()
    const instance = createBrokerServer(cfg, capabilities, runner)
    servers.push(instance)
    await listenBroker(cfg, instance.server)
    const payload = JSON.stringify({ ...brokerRequest(), cwd: '/repo' })
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        socketPath: cfg.socketPath,
        path: '/execute',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-broker-protocol-version': String(BROKER_PROTOCOL_VERSION),
        },
      }, (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode ?? 0))
      })
      request.once('error', reject)
      request.end(payload)
    })
    expect(status).toBe(400)
    expect(runner.calls).toHaveLength(0)
  })

  it('responde 413 e não executa quando o request interno excede o limite', async () => {
    const root = directory()
    const cfg = { ...config(root), maxRequestBytes: 32 }
    const runner = new FakeRunner()
    const instance = createBrokerServer(cfg, capabilities, runner)
    servers.push(instance)
    await listenBroker(cfg, instance.server)
    const payload = JSON.stringify(brokerRequest())
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        socketPath: cfg.socketPath,
        path: '/execute',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-broker-protocol-version': String(BROKER_PROTOCOL_VERSION),
        },
      }, (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode ?? 0))
      })
      request.once('error', reject)
      request.end(payload)
    })
    expect(status).toBe(413)
    expect(runner.calls).toHaveLength(0)
  })

  it('não enfileira uma segunda execução', async () => {
    const root = directory()
    const cfg = config(root)
    let release: (() => void) | undefined
    let started: (() => void) | undefined
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    const runner: ProcessRunnerLike = {
      async run(spec) {
        started?.()
        await new Promise<void>((resolve) => { release = resolve })
        writeFileSync(join(spec.cwd, 'final.json'), '{"content":"ok","tool_calls":[]}')
        return completed()
      },
    }
    const instance = createBrokerServer(cfg, {
      ...capabilities,
      codex: { available: true, binaryPath: process.execPath, authDir: join(root, 'auth') },
    }, runner)
    servers.push(instance)
    await listenBroker(cfg, instance.server)
    const client = new CliBrokerClient(cfg.socketPath, 1000)
    const first = client.execute(brokerRequest())
    await startedPromise
    await expect(client.execute({ ...brokerRequest(), requestId: 'request-2' })).rejects.toBeInstanceOf(CliBusyError)
    release?.()
    await expect(first).resolves.toMatchObject({ decision: { content: 'ok' } })
  })
})
