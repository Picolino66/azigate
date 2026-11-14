import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { parseChatArgs } from '../src/agent-client/args.js'
import { AgentApi, AgentApiError } from '../src/agent-client/api.js'
import { ChatController, type ChatIo } from '../src/agent-client/chat.js'
import { formatUsage, renderEvent, toolLabel } from '../src/agent-client/render.js'
import { createAgentdApp, type AgentdRuntime } from '../src/agentd/app.js'
import { loadAgentdConfig } from '../src/agentd/config.js'
import type { AgentEvent } from '../src/agents/core/agent-event.js'
import type { AgentProvider, AgentProviderId } from '../src/agents/core/agent-provider.js'
import { MemorySessionStore } from '../src/agent-control/session-store.js'
import { signWorkerToken } from '../src/workspace/security/token.js'
import { WorkspaceConnection } from '../src/workspace/server/connection.js'
import { WorkerHandler } from '../src/workspace/server/handler.js'
import { tempDir } from './helpers/agents.js'
import { ScriptedProvider } from './helpers/scripted-provider.js'

const KEY = 'chave-do-cliente-agent-0001'
const SECRET = 'segredo-de-worker-cliente-com-mais-de-32-caracteres'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('tempo esgotado')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function agentd(): Promise<{ runtime: AgentdRuntime; claude: ScriptedProvider; url: string }> {
  const config = loadAgentdConfig({
    AGENT_GATEWAY_ENABLED: 'true',
    AGENT_API_KEYS: KEY,
    AGENT_DATA_DIR: tempDir('azcli-'),
    CLAUDE_AGENT_ENABLED: 'true',
    WORKER_ENABLED: 'true',
    WORKER_TOKEN_SECRET: SECRET,
  })
  const claude = new ScriptedProvider('claude', true)
  const runtime = await createAgentdApp(config, {
    logger: pino({ level: 'silent' }),
    store: new MemorySessionStore(),
    providers: new Map<AgentProviderId, AgentProvider>([['claude', claude]]),
    localWorkspaces: new Map([['local-a', tempDir()]]),
    mcpBridge: { command: process.execPath, args: ['bridge.js'] },
  })
  cleanups.push(() => runtime.app.close())
  await runtime.app.listen({ host: '127.0.0.1', port: 0 })
  const address = runtime.app.server.address()
  if (!address || typeof address === 'string') throw new Error('endereço inválido')
  return { runtime, claude, url: `http://127.0.0.1:${address.port}` }
}

async function connectWorkspace(url: string): Promise<void> {
  const logs: string[] = []
  const connection = new WorkspaceConnection({
    url: new URL(`${url.replace('http', 'ws')}/worker/v1/connect`),
    workerId: 'maquina-b',
    token: () => signWorkerToken(SECRET, { workerId: 'maquina-b', workspaces: ['meu-projeto'], ttlSeconds: 60 }),
    handler: new WorkerHandler(new Map([['meu-projeto', tempDir()]]), { enabled: false }),
    version: 'teste',
    log: (event) => logs.push(event),
  })
  connection.start()
  cleanups.push(() => connection.stop())
  await waitFor(() => logs.includes('worker_registered'))
}

function scriptedIo(lines: string[], answers: string[] = []): { io: ChatIo; output: () => string; prompts: string[]; interrupt: () => void } {
  let written = ''
  const prompts: string[] = []
  let handler: () => void = () => undefined
  return {
    io: {
      write: (text) => {
        written += text
      },
      ask: (prompt) => {
        prompts.push(prompt)
        if (prompt.includes('Aprovar')) return Promise.resolve(answers.shift() ?? 'n')
        return Promise.resolve(lines.shift() ?? null)
      },
      onInterrupt: (next) => {
        handler = next
      },
    },
    output: () => written,
    prompts,
    interrupt: () => handler(),
  }
}

describe('azigate-agent — argumentos e renderização', () => {
  it('interpreta o comando chat', () => {
    expect(parseChatArgs(['codex', 'meu-projeto', '--worker', 'b', '--effort', 'high', '--mode', 'plan', '--keep', '--reasoning'])).toEqual({
      provider: 'codex',
      workspace: 'meu-projeto',
      worker: 'b',
      effort: 'high',
      mode: 'plan',
      keep: true,
      reasoning: true,
    })
    expect(parseChatArgs(['agy', 'x', '--local', '--model', 'm', '--resume', 'agt_1'])).toMatchObject({ local: true, model: 'm', resume: 'agt_1' })
    expect(() => parseChatArgs(['claude'])).toThrow(/Uso/u)
    expect(() => parseChatArgs(['claude', 'x', '--inexistente'])).toThrow(/desconhecida/u)
    expect(() => parseChatArgs(['claude', 'x', '--worker'])).toThrow(/ausente/u)
  })

  it('rotula ferramentas do workspace e eventos', () => {
    expect(toolLabel('mcp__azigate_workspace__read_file', 'package.json')).toBe('READ package.json')
    expect(toolLabel('mcp__azigate_workspace__shell_exec', 'npm test')).toBe('RUN npm test')
    expect(toolLabel('mcp__azigate_workspace__write_file', 'write_file a.txt')).toBe('WRITE a.txt')
    expect(toolLabel('Task', 'revisar')).toBe('TASK revisar')
    expect(toolLabel(undefined)).toBe('FERRAMENTA')
    const base = { id: 1, sessionId: 's', provider: 'claude', timestamp: 't' } as const
    const render = (event: Partial<AgentEvent>, reasoning = false): string | undefined =>
      renderEvent({ ...base, event: 'provider.event', ...event }, { reasoning })
    expect(render({ event: 'tool.completed', status: 'failed', tool: 'mcp__azigate_workspace__git_diff' })).toContain('✗ GIT DIFF')
    expect(render({ event: 'tool.completed', status: 'completed' })).toBeUndefined()
    expect(render({ event: 'reasoning.delta', text: 'hum' })).toBeUndefined()
    expect(render({ event: 'reasoning.delta', text: 'hum' }, true)).toContain('hum')
    expect(render({ event: 'subagent.started' })).toContain('subagente')
    expect(render({ event: 'subagent.completed' })).toContain('subagente')
    expect(render({ event: 'approval.resolved', reason: 'timeout' })).toContain('expirada')
    expect(render({ event: 'approval.resolved', reason: 'client' })).toBeUndefined()
    expect(render({ event: 'turn.failed', error: { code: 'turn_cancelled', message: 'x' } })).toContain('turn_cancelled')
    expect(formatUsage({ inputTokens: 10, outputTokens: 2, costUsd: 0.5 })).toBe('tokens: entrada 10 · saída 2 · US$ 0.5000')
    expect(formatUsage(undefined)).toBeUndefined()
    expect(formatUsage({})).toBeUndefined()
  })
})

describe('azigate-agent — chat', () => {
  it('detecta o workspace server, mostra streaming, ferramenta e aprovação y/N, e encerra a sessão', async () => {
    const { claude, url, runtime } = await agentd()
    await connectWorkspace(url)
    const api = new AgentApi(url, KEY)
    const { io, output, prompts } = scriptedIo(['analise o projeto', '', 'segundo turno', '/sair'], ['y'])
    const done = new ChatController(api, io, { provider: 'claude', workspace: 'meu-projeto' }).run()

    await waitFor(() => claude.runtimes.at(-1)?.inputs.length === 1)
    const runtimeA = claude.last
    expect(runtimeA.options.workspace).toMatchObject({ kind: 'remote', workerId: 'maquina-b', id: 'meu-projeto' })
    runtimeA.push({ event: 'message.delta', text: 'Vou analisar.', native: {} })
    runtimeA.push({ event: 'tool.started', tool: 'mcp__azigate_workspace__read_file', summary: 'package.json', toolCallId: 't1', native: {} })
    const decision = runtimeA.context.requestApproval({ tool: 'mcp__azigate_workspace__shell_exec', summary: 'npm test', native: {} })
    await expect(decision).resolves.toBe('allow')
    runtimeA.push({ event: 'usage', usage: { inputTokens: 5, outputTokens: 3 }, native: {} })
    runtimeA.push({ event: 'turn.completed', output: 'ok', native: {} })

    await waitFor(() => runtimeA.inputs.length === 2)
    runtimeA.push({ event: 'message.delta', text: 'Lembro do contexto.', native: {} })
    runtimeA.push({ event: 'turn.completed', native: {} })
    expect(await done).toBe(0)

    const text = output()
    expect(text).toContain('provider: claude')
    expect(text).toContain('workspace host: maquina-b')
    expect(text).toContain('workspace: meu-projeto')
    expect(text).toContain('Claude:\nVou analisar.')
    expect(text).toContain('▸ READ package.json')
    expect(text).toContain('✓ aprovado')
    expect(text).toContain('tokens: entrada 5 · saída 3')
    expect(text).toContain('Lembro do contexto.')
    expect(text).toContain('sessão encerrada.')
    expect(prompts.some((prompt) => prompt.includes('Aprovar RUN npm test? [y/N]'))).toBe(true)
    expect(runtimeA.inputs.map((input) => input.text)).toEqual(['analise o projeto', 'segundo turno'])
    const sessionId = /sessão: (agt_\w+)/u.exec(text)?.[1] ?? ''
    expect((await api.session(sessionId)).status).toBe('closed')
    expect(runtime.workers?.list()).toHaveLength(1)
  })

  it('nega por padrão, cancela com Ctrl+C e mantém a sessão com --keep', async () => {
    const { claude, url } = await agentd()
    const api = new AgentApi(url, KEY)
    const { io, output, interrupt } = scriptedIo(['faça algo', '/cancelar', '/sair'], [''])
    const done = new ChatController(api, io, { provider: 'claude', workspace: 'local-a', local: true, keep: true }).run()
    await waitFor(() => claude.runtimes.at(-1)?.inputs.length === 1)
    const runtimeA = claude.last
    await expect(runtimeA.context.requestApproval({ tool: 'mcp__azigate_workspace__delete', summary: 'delete x', native: {} })).resolves.toBe('deny')
    interrupt()
    expect(await done).toBe(0)
    const text = output()
    expect(text).toContain('workspace host: 127.0.0.1')
    expect(text).toContain('✗ negado')
    expect(text).toContain('cancelando o turno')
    expect(text).toContain('turn_cancelled')
    expect(text).toContain('nenhum turno em andamento')
    const sessionId = /sessão mantida: (agt_\w+)/u.exec(text)?.[1] ?? ''
    expect((await api.session(sessionId)).status).toBe('ready')
  })

  it('retoma uma sessão existente e reporta erros da API', async () => {
    const { url } = await agentd()
    const api = new AgentApi(url, KEY)
    const missing = scriptedIo([])
    expect(await new ChatController(api, missing.io, { provider: 'claude', workspace: 'meu-projeto' }).run()).toBe(1)
    expect(missing.output()).toContain('nenhum Workspace Server conectado expõe "meu-projeto"')

    const created = await api.createSession({ provider: 'claude', workspace: 'local-a' })
    const resumed = scriptedIo(['/sair'])
    expect(await new ChatController(api, resumed.io, { provider: 'claude', workspace: 'local-a', resume: created.id }).run()).toBe(0)
    expect(resumed.output()).toContain(`sessão: ${created.id}`)

    await expect(new AgentApi(url, 'chave-errada-0000000').providers()).rejects.toBeInstanceOf(AgentApiError)
    const bad = scriptedIo([])
    expect(await new ChatController(new AgentApi(url, 'chave-errada-0000000'), bad.io, { provider: 'claude', workspace: 'x', local: true }).run()).toBe(1)
    expect(bad.output()).toContain('invalid_agent_key')
    expect(Object.keys(await api.providers())).toEqual(['claude'])
  })
})
