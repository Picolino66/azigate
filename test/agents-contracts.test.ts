import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AgyEventMapper } from '../src/agents/agy/agy-events.js'
import { ClaudeEventMapper, summarizeToolInput } from '../src/agents/claude/claude-events.js'
import { CodexEventMapper, codexApprovalRequest } from '../src/agents/codex/codex-events.js'
import type { AgentEventDraft } from '../src/agents/core/agent-event.js'

function fixture(name: string): Record<string, unknown>[] {
  return readFileSync(new URL(`./fixtures/agents/contracts/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function eventsOf(result: { kind: string; events?: AgentEventDraft[] }): AgentEventDraft[] {
  return result.events ?? []
}

describe('contrato Claude Code 2.1.280', () => {
  const lines = fixture('claude-2.1.280.jsonl')

  it('mapeia init, deltas, ferramentas, subagente, permissão e resultado preservando native', () => {
    const mapper = new ClaudeEventMapper()
    const results = lines.map((line) => mapper.map(line))

    expect(results[0]).toEqual({ kind: 'control_response', requestId: 'azg_1', success: true })

    const init = eventsOf(results[1] as never)
    expect(init[0]).toMatchObject({ event: 'session.started', nativeSessionId: '3b6a1f5e-6c1d-4a8b-9e0f-2d7c4b1a9e33', model: 'claude-opus-5-5' })
    expect(init[0]?.native).toBe(lines[1])

    expect(eventsOf(results[2] as never)[0]).toMatchObject({ event: 'message.delta', text: 'Vou rodar os testes.' })
    expect(eventsOf(results[3] as never)[0]).toMatchObject({ event: 'reasoning.delta', text: 'preciso do npm test' })

    const assistant = eventsOf(results[4] as never)
    // O texto já veio por delta parcial; a mensagem completa não o duplica.
    expect(assistant.map((event) => event.event)).toEqual(['tool.started', 'tool.started', 'subagent.started'])
    expect(assistant[0]).toMatchObject({ tool: 'Bash', toolCallId: 'toolu_01' })

    expect(results[5]).toMatchObject({ kind: 'permission_request', requestId: 'req_7', tool: 'Bash', input: { command: 'npm test' } })

    const toolResults = eventsOf(results[6] as never)
    expect(toolResults).toEqual([
      expect.objectContaining({ event: 'tool.completed', tool: 'Bash', toolCallId: 'toolu_01', status: 'completed' }),
      expect.objectContaining({ event: 'tool.completed', tool: 'Task', toolCallId: 'toolu_02', status: 'failed' }),
      expect.objectContaining({ event: 'subagent.completed', toolCallId: 'toolu_02', status: 'failed' }),
    ])

    // Mensagens internas de subagente seguem apenas como evento nativo.
    expect(eventsOf(results[7] as never)).toEqual([{ event: 'provider.event', native: lines[7] }])

    const success = results[8]
    expect(success).toMatchObject({ kind: 'terminal', success: true, output: 'Testes passando.' })
    expect(eventsOf(success as never)[0]).toMatchObject({
      event: 'usage',
      usage: { inputTokens: 1050, outputTokens: 120, cachedInputTokens: 900, totalTokens: 1170, costUsd: 0.042 },
    })
    expect(results[9]).toMatchObject({ kind: 'terminal', success: false })
    expect(results[10]).toEqual({ kind: 'control_cancel', requestId: 'req_7' })
    expect(eventsOf(results[11] as never)).toEqual([{ event: 'provider.event', native: lines[11] }])
    expect(results[12]).toEqual({ kind: 'ignored' })
  })

  it('emite o texto completo quando não houve delta parcial', () => {
    const mapper = new ClaudeEventMapper()
    const events = eventsOf(mapper.map(lines[4]))
    expect(events[0]).toMatchObject({ event: 'message.delta', text: 'Vou rodar os testes.' })
  })

  it('recusa pedidos de controle sem suporte e mensagens inválidas', () => {
    const mapper = new ClaudeEventMapper()
    expect(mapper.map({ type: 'control_request', request_id: 'x', request: { subtype: 'hook_callback' } })).toEqual({
      kind: 'unsupported_control_request',
      requestId: 'x',
    })
    expect(mapper.map('texto')).toEqual({ kind: 'invalid' })
    expect(mapper.map({ type: 'control_request' })).toEqual({ kind: 'invalid' })
    expect(mapper.map({ type: 'control_response', response: {} })).toEqual({ kind: 'invalid' })
    expect(eventsOf(mapper.map({ type: 'system', subtype: 'compact_boundary' }) as never)[0]?.event).toBe('provider.event')
  })

  it('resume o input da ferramenta para o aprovador, com truncamento', () => {
    expect(summarizeToolInput('Bash', { command: 'npm test' })).toBe('npm test')
    expect(summarizeToolInput('mcp__azigate_workspace__shell_exec', { argv: ['npm', 'install', 'x'] })).toBe('npm install x')
    expect(summarizeToolInput('Edit', { file_path: 'src/a.ts' })).toBe('src/a.ts')
    expect(summarizeToolInput('Outro', 'texto')).toBe('Outro')
    expect(summarizeToolInput('Bash', { command: 'x'.repeat(600) })).toHaveLength(500)
  })
})

describe.each(['1.2.10', '1.2.11'])('contrato AGY %s', (version) => {
  const lines = fixture(`agy-${version}.jsonl`)

  it('mapeia init e result capturados da CLI', () => {
    const mapper = new AgyEventMapper()
    const init = mapper.map(lines[0])
    const conversationId = (lines[0] as { conversation_id: string }).conversation_id
    expect(init).toMatchObject({ kind: 'init', conversationId })
    expect(eventsOf(init as never)[0]).toMatchObject({ event: 'session.started', nativeSessionId: conversationId })

    const failure = mapper.map(lines[1])
    expect(failure).toMatchObject({ kind: 'terminal', success: false })
    expect(failure).not.toHaveProperty('output')

    const success = mapper.map(lines[2])
    expect(success).toMatchObject({ kind: 'terminal', success: true, output: 'Pronto' })
    expect(eventsOf(success as never)[0]).toMatchObject({
      event: 'usage',
      usage: { inputTokens: 1200, outputTokens: 40, reasoningTokens: 12, cachedInputTokens: 800, totalTokens: 1252 },
    })
  })

  it('mapeia step_update com tool_info e subagent_info de forma tolerante', () => {
    const mapper = new AgyEventMapper()
    const started = mapper.map({ event: 'step_update', step_update: { step_index: 4, status: 'RUNNING', tool_info: { name: 'run_command' } } })
    expect(eventsOf(started as never)).toEqual([expect.objectContaining({ event: 'tool.started', tool: 'run_command', toolCallId: 'step_4' })])
    const done = mapper.map({ event: 'step_update', step_update: { step_index: 4, status: 'STEP_STATUS_ERROR', tool_info: { name: 'run_command' } } })
    expect(eventsOf(done as never)).toEqual([expect.objectContaining({ event: 'tool.completed', status: 'failed' })])

    const subagent = mapper.map({
      event: 'step_update',
      step_update: { step_id: 's9', status: 'DONE', subagent_info: { conversation_id: 'filho' } },
    })
    expect(eventsOf(subagent as never).map((event) => event.event)).toEqual(['subagent.started', 'subagent.completed'])
    expect(eventsOf(subagent as never)[0]).toMatchObject({ nativeSessionId: 'filho' })

    const text = mapper.map({ event: 'step_update', text_delta: 'oi', thinking_delta: 'hum' })
    expect(eventsOf(text as never).map((event) => event.event)).toEqual(['message.delta', 'reasoning.delta'])

    const unknown = { event: 'step_update', step_update: { step_index: 5, step_type: 'CHECKPOINT' } }
    expect(eventsOf(mapper.map(unknown) as never)).toEqual([{ event: 'provider.event', native: unknown }])
    expect(eventsOf(mapper.map({ event: 'futuro' }) as never)[0]?.event).toBe('provider.event')
    expect(mapper.map(null)).toEqual({ kind: 'invalid' })
  })
})

describe('contrato Codex app-server 0.144.6', () => {
  const lines = fixture('codex-0.144.6.jsonl')

  it('mapeia notificações do protocolo v2 e guarda a mensagem final', () => {
    const mapper = new CodexEventMapper()
    const mapped = lines.slice(1).map((line) => mapper.map(line.method as string, line.params, line))
    expect(eventsOf(mapped[0] as never)[0]).toEqual({ event: 'provider.event', native: lines[1] })
    expect(eventsOf(mapped[1] as never)[0]).toMatchObject({ event: 'message.delta', text: 'Olá' })
    expect(eventsOf(mapped[2] as never)[0]).toMatchObject({ event: 'reasoning.delta', text: 'resumo' })
    expect(eventsOf(mapped[3] as never)[0]).toMatchObject({ event: 'tool.started', tool: 'mcp__docs__search', toolCallId: 'c1' })
    expect(eventsOf(mapped[4] as never)[0]).toMatchObject({ event: 'tool.completed', status: 'failed' })
    expect(eventsOf(mapped[5] as never)[0]).toMatchObject({ event: 'subagent.started', toolCallId: 's1' })
    expect(eventsOf(mapped[6] as never)[0]).toMatchObject({ event: 'subagent.completed', status: 'completed' })
    expect(mapper.output).toBe('Olá, terminei.')
    expect(eventsOf(mapped[8] as never)[0]).toMatchObject({
      event: 'usage',
      usage: { inputTokens: 250, outputTokens: 50, cachedInputTokens: 200, reasoningTokens: 20, totalTokens: 300 },
    })
    expect(mapped[9]).toMatchObject({ kind: 'turn_completed', status: 'completed' })
  })

  it('traduz pedidos de aprovação suportados e recusa os demais', () => {
    const command = codexApprovalRequest('item/commandExecution/requestApproval', { command: 'rm -rf build' })
    expect(command).toMatchObject({ tool: 'commandExecution', summary: 'rm -rf build' })
    expect(command?.respond('allow')).toEqual({ decision: 'accept' })
    expect(command?.respond('deny')).toEqual({ decision: 'decline' })

    const file = codexApprovalRequest('item/fileChange/requestApproval', {})
    expect(file?.respond('allow')).toEqual({ decision: 'accept' })

    const permissions = codexApprovalRequest('item/permissions/requestApproval', {
      permissions: { network: { enabled: true }, fileSystem: null },
    })
    expect(permissions?.respond('allow')).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' })
    expect(permissions?.respond('deny')).toEqual({ permissions: {}, scope: 'turn' })

    const legacy = codexApprovalRequest('execCommandApproval', { command: ['git', 'push'] })
    expect(legacy?.summary).toBe('git push')
    expect(legacy?.respond('allow')).toEqual({ decision: 'approved' })
    expect(codexApprovalRequest('applyPatchApproval', { fileChanges: { 'a.ts': {} } })?.respond('deny')).toEqual({ decision: 'denied' })

    for (const method of ['item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/tool/call', 'account/chatgptAuthTokens/refresh', 'attestation/generate']) {
      expect(codexApprovalRequest(method, {})).toBeUndefined()
    }
  })

  it('preserva itens sem mapeamento como evento nativo', () => {
    const mapper = new CodexEventMapper()
    const raw = { method: 'item/started', params: { item: { type: 'plan', id: 'p1' } } }
    expect(eventsOf(mapper.map('item/started', raw.params, raw) as never)).toEqual([{ event: 'provider.event', native: raw }])
    const noItem = { method: 'item/completed', params: {} }
    expect(eventsOf(mapper.map('item/completed', noItem.params, noItem) as never)[0]?.event).toBe('provider.event')
  })
})
