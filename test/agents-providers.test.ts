import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgyAgentProvider, buildAgyArgs } from '../src/agents/agy/agy-provider.js'
import { ClaudeAgentProvider, buildClaudeArgs } from '../src/agents/claude/claude-provider.js'
import { CodexAgentProvider, codexThreadSettings } from '../src/agents/codex/codex-provider.js'
import type { AgentRuntimeSession } from '../src/agents/core/agent-provider.js'
import { AgentResumeError, AgentStartError } from '../src/agents/core/process-session.js'
import { collect, fakeBinary, localOptions, readJson, tempDir, testContext, types } from './helpers/agents.js'

const sessions: AgentRuntimeSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})

function track<T extends AgentRuntimeSession>(session: T): T {
  sessions.push(session)
  return session
}

describe('Claude Code (stream-json)', () => {
  const provider = new ClaudeAgentProvider({ binary: fakeBinary('fake-claude'), inspectionCwd: tempDir(), interruptGraceMs: 2000 })

  it('inicia com argv fixo, handshake de controle e sessão nativa pré-atribuída', async () => {
    const root = tempDir()
    const context = testContext()
    const session = track(
      await provider.createSession(localOptions(root, { model: 'sonnet', effort: 'high', permissionMode: 'review' }), context),
    )
    const argv = readJson<string[]>(join(root, '.fake-argv.json'))
    expect(argv.slice(0, 11)).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      'manual',
    ])
    expect(argv).toContain('--session-id')
    expect(argv).not.toContain('--dangerously-skip-permissions')
    expect(argv.slice(-4)).toEqual(['--model', 'sonnet', '--effort', 'high'])
    expect(session.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/u)
    // O initialize devolve dados da conta e nunca pode virar evento.
    expect(JSON.stringify(context.emitted)).not.toContain('segredo@example.com')
  })

  it('transmite deltas sem duplicar o texto e conclui com usage e output', async () => {
    const root = tempDir()
    const session = track(await provider.createSession(localOptions(root), testContext()))
    const events = await collect(session.startTurn({ turnId: 'trn_1', text: 'oi' }))
    expect(types(events)).toEqual(['session.started', 'message.delta', 'message.delta', 'provider.event', 'usage', 'turn.completed'])
    expect(events.at(-1)).toMatchObject({ output: 'Olá mundo' })
    expect(events[4]?.usage).toMatchObject({ inputTokens: 17, cachedInputTokens: 5, outputTokens: 7, totalTokens: 24 })
  })

  it('encaminha can_use_tool para a aprovação do Azigate', async () => {
    const allow = testContext(() => 'allow')
    const allowed = track(await provider.createSession(localOptions(tempDir()), allow))
    const allowedEvents = await collect(allowed.startTurn({ turnId: 'trn_1', text: 'ferramenta' }))
    expect(allow.approvals[0]).toMatchObject({ tool: 'Bash', summary: 'npm test' })
    expect(allowedEvents.find((event) => event.event === 'tool.completed')).toMatchObject({ status: 'completed' })
    expect(allowedEvents.at(-1)).toMatchObject({ event: 'turn.completed', output: 'ferramenta executada' })

    const denied = track(await provider.createSession(localOptions(tempDir()), testContext(() => 'deny')))
    const deniedEvents = await collect(denied.startTurn({ turnId: 'trn_2', text: 'ferramenta' }))
    expect(deniedEvents.find((event) => event.event === 'tool.completed')).toMatchObject({ status: 'failed' })
  })

  it('mapeia falha, cancelamento por interrupt e morte do processo', async () => {
    const session = track(await provider.createSession(localOptions(tempDir()), testContext()))
    const failed = await collect(session.startTurn({ turnId: 'trn_1', text: 'falha' }))
    expect(failed.at(-1)).toMatchObject({ event: 'turn.failed', error: { code: 'agent_turn_failed' } })

    const pending = collect(session.startTurn({ turnId: 'trn_2', text: 'trava' }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    await session.cancelTurn()
    expect((await pending).at(-1)).toMatchObject({ event: 'turn.failed', error: { code: 'turn_cancelled' } })

    let exited = false
    session.onExit(() => {
      exited = true
    })
    const died = await collect(session.startTurn({ turnId: 'trn_3', text: 'morre' }))
    expect(died.at(-1)).toMatchObject({ event: 'turn.failed', error: { code: 'agent_process_exited' } })
    expect(exited).toBe(true)
    const afterDeath = await collect(session.startTurn({ turnId: 'trn_4', text: 'oi' }))
    expect(afterDeath).toHaveLength(1)
    expect(afterDeath[0]).toMatchObject({ event: 'turn.failed', error: { code: 'agent_process_exited' } })
  })

  it('falha o início quando a sessão a retomar não existe', async () => {
    await expect(provider.resumeSession('inexistente', localOptions(tempDir()), testContext())).rejects.toBeInstanceOf(AgentStartError)
    await expect(provider.resumeSession('-flag', localOptions(tempDir()), testContext())).rejects.toThrow()
  })

  it('usa --resume com o ID nativo', async () => {
    const root = tempDir()
    const session = track(await provider.resumeSession('3b6a1f5e-6c1d-4a8b-9e0f-2d7c4b1a9e33', localOptions(root), testContext()))
    const argv = readJson<string[]>(join(root, '.fake-argv.json'))
    expect(argv[argv.indexOf('--resume') + 1]).toBe('3b6a1f5e-6c1d-4a8b-9e0f-2d7c4b1a9e33')
    expect(session.nativeSessionId).toBe('3b6a1f5e-6c1d-4a8b-9e0f-2d7c4b1a9e33')
  })

  it('desliga ferramentas locais e usa somente MCP em workspace remoto', async () => {
    const sessionDir = tempDir()
    const session = track(
      await provider.createSession(
        {
          sessionId: 'agt_000000000000000000000001',
          workspace: {
            kind: 'remote',
            id: 'backend',
            workerId: 'devbox',
            mcpConfigPath: join(sessionDir, 'mcp-config.json'),
            allowedTools: ['mcp__azigate_workspace__read_file', 'mcp__azigate_workspace__git_status'],
          },
          sessionDir,
          permissionMode: 'plan',
        },
        testContext(),
      ),
    )
    expect(session.nativeSessionId).toBeDefined()
    const argv = readJson<string[]>(join(sessionDir, '.fake-argv.json'))
    expect(argv[argv.indexOf('--tools') + 1]).toBe('')
    expect(argv).toContain('--strict-mcp-config')
    expect(argv[argv.indexOf('--mcp-config') + 1]).toBe(join(sessionDir, 'mcp-config.json'))
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('mcp__azigate_workspace__read_file,mcp__azigate_workspace__git_status')
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('plan')
  })

  it('verifica instalação, login e versão sem abrir sessão', async () => {
    await expect(provider.health()).resolves.toEqual({ installed: true, authenticated: true, version: '2.1.280' })
    const missing = new ClaudeAgentProvider({ binary: '/nao/existe/claude', inspectionCwd: tempDir() })
    await expect(missing.health()).resolves.toEqual({ installed: false, authenticated: null, version: null })
  })

  it('recusa identificador nativo inseguro no argv', () => {
    expect(() => buildClaudeArgs(localOptions('/tmp'), { mode: 'resume', nativeSessionId: '--dangerously-skip-permissions' })).toThrow()
  })
})

describe('AGY (stream-json headless)', () => {
  const provider = new AgyAgentProvider({ binary: fakeBinary('fake-agy'), inspectionCwd: tempDir(), interruptGraceMs: 2000 })

  it('espera o init, guarda o conversation_id e monta o argv', async () => {
    const root = tempDir()
    const context = testContext()
    const session = track(
      await provider.createSession(localOptions(root, { model: 'gemini-x', effort: 'high', permissionMode: 'acceptEdits' }), context),
    )
    expect(session.nativeSessionId).toBe('conv-nova-0001')
    expect(context.emitted[0]).toMatchObject({ event: 'session.started', nativeSessionId: 'conv-nova-0001' })
    expect(readJson<string[]>(join(root, '.fake-argv.json'))).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      'gemini-x',
      '--effort',
      'high',
      '--mode',
      'accept-edits',
    ])
    expect(buildAgyArgs(localOptions(root, { permissionMode: 'plan' }))).toContain('plan')
    expect(buildAgyArgs(localOptions(root))).not.toContain('--mode')
  })

  it('mapeia ferramentas, subagentes, usage e resultado de um turno', async () => {
    const session = track(await provider.createSession(localOptions(tempDir()), testContext()))
    const events = await collect(session.startTurn({ turnId: 'trn_1', text: 'faça' }))
    expect(types(events)).toEqual([
      'tool.started',
      'tool.completed',
      'subagent.started',
      'subagent.completed',
      'provider.event',
      'usage',
      'turn.completed',
    ])
    expect(events.at(-1)).toMatchObject({ output: 'Pronto' })
    const failed = await collect(session.startTurn({ turnId: 'trn_2', text: 'falha' }))
    expect(failed.at(-1)).toMatchObject({ event: 'turn.failed', error: { code: 'agent_turn_failed' } })
  })

  it('cancela por SIGINT e detecta retomada que criaria conversa nova', async () => {
    const session = track(await provider.createSession(localOptions(tempDir()), testContext()))
    const pending = collect(session.startTurn({ turnId: 'trn_1', text: 'trava' }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    await session.cancelTurn()
    expect((await pending).at(-1)).toMatchObject({ event: 'turn.failed', error: { code: 'turn_cancelled' } })

    await expect(provider.resumeSession('inexistente', localOptions(tempDir()), testContext())).rejects.toBeInstanceOf(AgentResumeError)
    const resumed = track(await provider.resumeSession('conv-existente', localOptions(tempDir()), testContext()))
    expect(resumed.nativeSessionId).toBe('conv-existente')
  })

  it('recusa workspace remoto e informa saúde', async () => {
    const remote = localOptions(tempDir())
    remote.workspace = { kind: 'remote', id: 'b', workerId: 'w', mcpConfigPath: '/tmp/x', allowedTools: [] }
    await expect(provider.createSession(remote, testContext())).rejects.toThrow()
    await expect(provider.health()).resolves.toEqual({ installed: true, authenticated: true, version: '1.2.10' })
  })
})

describe('Codex app-server (JSON-RPC)', () => {
  const provider = new CodexAgentProvider({ binary: fakeBinary('fake-codex'), inspectionCwd: tempDir(), requestTimeoutMs: 3000 })

  it('inicializa, abre thread com política segura e emite session.started', async () => {
    const root = tempDir()
    const context = testContext()
    const session = track(await provider.createSession(localOptions(root, { model: 'gpt-x' }), context))
    expect(session.nativeSessionId).toBe('thread-0001')
    expect(readJson<string[]>(join(root, '.fake-argv.json'))).toEqual(['app-server'])
    expect(readJson<{ method: string; params: Record<string, unknown> }>(join(root, '.fake-thread-params.json'))).toEqual({
      method: 'thread/start',
      params: { cwd: root, approvalPolicy: 'untrusted', sandbox: 'workspace-write', model: 'gpt-x' },
    })
    expect(context.emitted[0]).toMatchObject({ event: 'session.started', nativeSessionId: 'thread-0001', model: 'gpt-x' })
    expect(codexThreadSettings(localOptions(root, { permissionMode: 'plan' }))).toMatchObject({ sandbox: 'read-only' })
    expect(codexThreadSettings(localOptions(root, { permissionMode: 'acceptEdits' }))).toMatchObject({ approvalPolicy: 'on-request' })
  })

  it('conclui turno com deltas, usage e mensagem final', async () => {
    const session = track(await provider.createSession(localOptions(tempDir(), { effort: 'low' }), testContext()))
    const events = await collect(session.startTurn({ turnId: 'trn_1', text: 'oi' }))
    expect(types(events)).toEqual(['provider.event', 'reasoning.delta', 'message.delta', 'provider.event', 'usage', 'turn.completed'])
    expect(events.at(-1)).toMatchObject({ output: 'Feito' })
  })

  it('traduz aprovação de comando nos dois sentidos', async () => {
    const allow = testContext(() => 'allow')
    const allowed = track(await provider.createSession(localOptions(tempDir()), allow))
    const allowedEvents = await collect(allowed.startTurn({ turnId: 'trn_1', text: 'comando' }))
    expect(allow.approvals[0]).toMatchObject({ tool: 'commandExecution', summary: 'npm test' })
    expect(allowedEvents.find((event) => event.event === 'tool.completed')).toMatchObject({ status: 'completed' })
    expect(allowedEvents.at(-1)).toMatchObject({ output: 'comando executado' })

    const denied = track(await provider.createSession(localOptions(tempDir()), testContext(() => 'deny')))
    const deniedEvents = await collect(denied.startTurn({ turnId: 'trn_2', text: 'comando' }))
    expect(deniedEvents.find((event) => event.event === 'tool.completed')).toMatchObject({ status: 'declined' })
  })

  it('interrompe com turn/interrupt, reporta falha e recusa pedidos não suportados', async () => {
    const root = tempDir()
    const session = track(await provider.createSession(localOptions(root), testContext()))
    const pending = collect(session.startTurn({ turnId: 'trn_1', text: 'trava' }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    await session.cancelTurn()
    expect((await pending).at(-1)).toMatchObject({ event: 'turn.failed', error: { code: 'turn_cancelled' } })

    const failed = await collect(session.startTurn({ turnId: 'trn_2', text: 'falha' }))
    expect(failed.at(-1)).toMatchObject({ event: 'turn.failed', error: { code: 'agent_turn_failed' } })

    const unsupported = await collect(session.startTurn({ turnId: 'trn_3', text: 'desconhecido' }))
    expect(unsupported.at(-1)).toMatchObject({ event: 'turn.completed' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(readJson<{ error: { code: number } }>(join(root, '.fake-last-error.json')).error.code).toBe(-32601)
  })

  it('retoma thread existente e falha quando ela não existe', async () => {
    const root = tempDir()
    const session = track(await provider.resumeSession('thread-antiga', localOptions(root), testContext()))
    expect(session.nativeSessionId).toBe('thread-antiga')
    expect(readJson<{ method: string }>(join(root, '.fake-thread-params.json')).method).toBe('thread/resume')
    await expect(provider.resumeSession('inexistente', localOptions(tempDir()), testContext())).rejects.toBeInstanceOf(AgentResumeError)
  })

  it('informa saúde com login ausente e recusa workspace remoto', async () => {
    await expect(provider.health()).resolves.toEqual({ installed: true, authenticated: false, version: '0.144.6' })
    const remote = localOptions(tempDir())
    remote.workspace = { kind: 'remote', id: 'b', workerId: 'w', mcpConfigPath: '/tmp/x', allowedTools: [] }
    await expect(provider.createSession(remote, testContext())).rejects.toThrow()
    expect(existsSync(join(remote.sessionDir, '.fake-argv.json'))).toBe(false)
  })
})
