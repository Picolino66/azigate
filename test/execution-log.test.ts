import { readFileSync, rmSync, statSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExecutionLogWriter } from '../src/broker/execution-log.js'
import { CodexTurnStateError } from '../src/broker/memory-executor.js'
import type { BrokerExecuteRequest } from '../src/broker/protocol.js'
import { CliExecutionFailedError, InvalidCliOutputError } from '../src/providers/errors.js'

const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'azigate-execution-log-'))
  roots.push(value)
  return value
}

function request(): BrokerExecuteRequest {
  return {
    version: 6,
    requestId: 'request-safe',
    provider: 'codex',
    model: 'gpt-5.4',
    effort: 'medium',
    messages: [{ role: 'user', content: 'PROMPT_ULTRASSECRETO' }],
    tools: [{
      name: 'read_file',
      description: 'ARGUMENTO_ULTRASSECRETO',
      parameters: { type: 'object', secret: 'SCHEMA_ULTRASSECRETO' },
    }],
    toolChoice: 'none',
    parallelToolCalls: false,
  }
}

afterEach(() => roots.splice(0).forEach((value) => rmSync(value, { recursive: true, force: true })))

describe('logs de execução do broker', () => {
  it('escreve apenas metadados sanitizados e mantém permissões privadas', async () => {
    const directory = join(root(), 'logs')
    const writer = new ExecutionLogWriter({
      executionLogDir: directory,
      executionLogMaxBytes: 65_536,
      executionLogMaxFiles: 2,
    }, request(), 'memory', 512)

    await writer.start()
    await writer.report({ phase: 'provider_turn_started' })
    await writer.fail(new InvalidCliOutputError('decision_tool_not_offered'))

    const body = readFileSync(join(directory, 'executions.jsonl'), 'utf8')
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(join(directory, 'executions.jsonl')).mode & 0o777).toBe(0o600)
    expect(body).toContain('provider_turn_started')
    expect(body).toContain('decision_tool_not_offered')
    expect(body).not.toContain('Authorization')
    expect(body).not.toContain('PROMPT_ULTRASSECRETO')
    expect(body).not.toContain('ARGUMENTO_ULTRASSECRETO')
    expect(body).not.toContain('SCHEMA_ULTRASSECRETO')
    expect(body).not.toContain('segredo')
    expect(body).not.toContain('arguments')
  })

  it('rotaciona o arquivo sem reter conteúdo além da política configurada', async () => {
    const directory = join(root(), 'logs')
    const configuration = { executionLogDir: directory, executionLogMaxBytes: 1, executionLogMaxFiles: 1 }
    const first = new ExecutionLogWriter(configuration, request(), 'stateless', 0)
    await first.start()
    const second = new ExecutionLogWriter(configuration, { ...request(), requestId: 'request-next' }, 'stateless', 0)
    await second.start()

    expect(readFileSync(join(directory, 'executions.1.jsonl'), 'utf8')).toContain('request-safe')
    expect(readFileSync(join(directory, 'executions.jsonl'), 'utf8')).toContain('request-next')
  })

  it('aceita a classificação sanitizada de falha RPC do Codex', async () => {
    const directory = join(root(), 'logs')
    const writer = new ExecutionLogWriter({
      executionLogDir: directory,
      executionLogMaxBytes: 65_536,
      executionLogMaxFiles: 2,
    }, request(), 'memory', 512)

    await writer.fail(new CliExecutionFailedError('codex_rpc_turn_start_failed'))

    const body = readFileSync(join(directory, 'executions.jsonl'), 'utf8')
    expect(body).toContain('codex_rpc_turn_start_failed')
    expect(body).not.toContain('PROMPT_ULTRASSECRETO')
  })

  it('registra o errorCode sanitizado somente quando pertence à allowlist', async () => {
    const directory = join(root(), 'logs')
    const configuration = { executionLogDir: directory, executionLogMaxBytes: 65_536, executionLogMaxFiles: 2 }
    const writer = new ExecutionLogWriter(configuration, request(), 'memory', 512)
    const classified = new CodexTurnStateError('codex_turn_error_event', 'bad_request')
    await writer.fail(classified)

    const forged = new CliExecutionFailedError('codex_turn_error_event') as CliExecutionFailedError & {
      sanitizedErrorCode?: string
    }
    forged.sanitizedErrorCode = 'MENSAGEM_ULTRASSECRETA'
    await writer.fail(forged)

    const lines = readFileSync(join(directory, 'executions.jsonl'), 'utf8').trim().split('\n')
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ reason: 'codex_turn_error_event', errorCode: 'bad_request' })
    expect(JSON.parse(lines[1] ?? '{}')).not.toHaveProperty('errorCode')
    expect(lines[1]).not.toContain('MENSAGEM_ULTRASSECRETA')
  })
})
