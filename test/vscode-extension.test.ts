import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentApi, AgentApiError, type SessionInfo, type WorkerInfo } from '../src/agent-client/api.js'
import { createAgentdApp } from '../src/agentd/app.js'
import { loadAgentdConfig } from '../src/agentd/config.js'
import type { AgentEvent } from '../src/agents/core/agent-event.js'
import type { AgentProvider, AgentProviderId } from '../src/agents/core/agent-provider.js'
import { MemorySessionStore } from '../src/agent-control/session-store.js'
import { signWorkerToken } from '../src/workspace/security/token.js'
import { WorkspaceConnection } from '../src/workspace/server/connection.js'
import { WorkerHandler } from '../src/workspace/server/handler.js'
import { loadLocalWorkspaces, resolveConnection, validateAgentUrl, workspaceForFolders } from '../src/vscode-extension/connection.js'
import { parseInboundMessage, type OutboundMessage } from '../src/vscode-extension/protocol.js'
import { SessionController, type AgentApiPort } from '../src/vscode-extension/session-controller.js'
import { createNonce, renderWebviewHtml } from '../src/vscode-extension/webview.js'
import { WorkspaceServerProcess, minimalEnv, validateServerCommand } from '../src/vscode-extension/workspace-process.js'
import { buildVscodeExtension, crc32, createZip, extensionManifest } from '../tools/vscode-package.js'
import { tempDir } from './helpers/agents.js'
import { ScriptedProvider } from './helpers/scripted-provider.js'

const KEY = 'chave-do-cliente-vscode-0001'
const SECRET = 'segredo-de-worker-vscode-com-mais-de-32-caracteres'

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

function recorder(): { post: (message: OutboundMessage) => void; messages: OutboundMessage[]; entries: () => string[] } {
  const messages: OutboundMessage[] = []
  return {
    post: (message) => messages.push(message),
    messages,
    entries: () =>
      messages.flatMap((message) => {
        if (message.type === 'entry') {
          const entry = message.entry
          return [`${entry.kind}:${'text' in entry ? entry.text : 'label' in entry ? entry.label : entry.provider}`]
        }
        if (message.type === 'delta') return [`delta:${message.text}`]
        if (message.type === 'approval') return [`approval:${message.label}`]
        if (message.type === 'approvalResolved') return [`resolved:${message.text}`]
        return []
      }),
  }
}

function lastState(messages: OutboundMessage[]): Extract<OutboundMessage, { type: 'state' }>['state'] {
  const state = messages.filter((message) => message.type === 'state').at(-1)
  if (!state || state.type !== 'state') throw new Error('sem estado')
  return state.state
}

/** Agent API falsa com stream de eventos controlado pelo teste. */
class FakeApi implements AgentApiPort {
  readonly calls: { method: string; args: unknown[] }[] = []
  workerList: WorkerInfo[] = [{ id: 'maquina-b', workspaces: ['meu-projeto'], capabilities: [] }]
  decideError: Error | undefined
  private pending: AgentEvent[] = []
  private wake: (() => void) | undefined
  private ended = false
  private nextId = 1

  providers(): Promise<Record<string, Record<string, unknown>>> {
    return Promise.resolve({ claude: { available: true }, codex: { available: false }, desconhecido: { available: true } })
  }
  workers(): Promise<WorkerInfo[]> {
    return Promise.resolve(this.workerList)
  }
  createSession(body: Record<string, unknown>): Promise<SessionInfo> {
    this.calls.push({ method: 'createSession', args: [body] })
    return Promise.resolve({ id: 'agt_1', provider: String(body.provider), status: 'ready', workspace: String(body.workspace), worker: 'maquina-b', model: null, nativeSessionId: null })
  }
  sendTurn(id: string, input: string): Promise<{ turnId: string }> {
    this.calls.push({ method: 'sendTurn', args: [id, input] })
    return Promise.resolve({ turnId: 'turn_1' })
  }
  decide(approvalId: string, decision: 'allow' | 'deny'): Promise<unknown> {
    this.calls.push({ method: 'decide', args: [approvalId, decision] })
    return this.decideError ? Promise.reject(this.decideError) : Promise.resolve({})
  }
  cancel(id: string): Promise<unknown> {
    this.calls.push({ method: 'cancel', args: [id] })
    return Promise.resolve({})
  }
  close(id: string): Promise<unknown> {
    this.calls.push({ method: 'close', args: [id] })
    return Promise.resolve({})
  }
  async *events(_id: string, _after: number, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    for (;;) {
      if (signal.aborted) return
      const event = this.pending.shift()
      if (event) {
        yield event
        continue
      }
      if (this.ended) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  }
  push(event: Partial<AgentEvent> & { event: AgentEvent['event'] }): void {
    this.pending.push({ id: this.nextId++, sessionId: 'agt_1', provider: 'claude', timestamp: 't', turnId: 'turn_1', ...event })
    this.wake?.()
  }
  endStream(): void {
    this.ended = true
    this.wake?.()
  }
  count(method: string): number {
    return this.calls.filter((call) => call.method === method).length
  }
}

describe('extensão VS Code — protocolo do webview', () => {
  it('aceita só mensagens conhecidas e IDs seguros', () => {
    expect(parseInboundMessage({ type: 'send', text: '  oi  ' })).toEqual({ type: 'send', text: 'oi' })
    expect(parseInboundMessage({ type: 'selectProvider', provider: 'agy' })).toEqual({ type: 'selectProvider', provider: 'agy' })
    expect(parseInboundMessage({ type: 'selectWorkspace', workspace: 'meu-projeto' })).toEqual({ type: 'selectWorkspace', workspace: 'meu-projeto' })
    expect(parseInboundMessage({ type: 'decide', approvalId: 'apr_1', decision: 'allow' })).toEqual({ type: 'decide', approvalId: 'apr_1', decision: 'allow' })
    expect(parseInboundMessage({ type: 'ready', extra: 1 })).toEqual({ type: 'ready' })
    for (const invalid of [
      null,
      'send',
      { type: 'send', text: '   ' },
      { type: 'send', text: 'x'.repeat(100_001) },
      { type: 'selectProvider', provider: 'gpt' },
      { type: 'selectWorkspace', workspace: '../etc' },
      { type: 'selectWorkspace', workspace: '/home/usuario/projeto' },
      { type: 'decide', approvalId: 'apr_1', decision: 'talvez' },
      { type: 'decide', approvalId: '', decision: 'allow' },
      { type: 'shell', command: 'rm -rf /' },
      { type: 'createSession', cwd: '/tmp' },
    ]) {
      expect(parseInboundMessage(invalid)).toBeUndefined()
    }
  })
})

describe('extensão VS Code — conexão e workspaces', () => {
  it('exige https fora de loopback e recusa credenciais na URL', () => {
    expect(validateAgentUrl('https://agentes.exemplo.com/')).toBe('https://agentes.exemplo.com')
    expect(validateAgentUrl('http://127.0.0.1:3100')).toBe('http://127.0.0.1:3100')
    expect(validateAgentUrl('http://localhost:3100')).toBe('http://localhost:3100')
    expect(() => validateAgentUrl('http://192.168.0.10:3100')).toThrow(/https/u)
    expect(() => validateAgentUrl('https://u:s@agentes.exemplo.com')).toThrow(/credenciais/u)
    expect(() => validateAgentUrl('https://agentes.exemplo.com/?x=1')).toThrow(/query/u)
    expect(() => validateAgentUrl('não é url')).toThrow(/inválida/u)
  })

  it('prefere a chave do SecretStorage e nem lê agent.key nesse caso', () => {
    const dir = tempDir('azvsc-')
    writeFileSync(join(dir, 'agent.json'), JSON.stringify({ url: 'https://agentes.exemplo.com' }))
    writeFileSync(join(dir, 'agent.key'), 'chave-em-arquivo')
    chmodSync(join(dir, 'agent.key'), 0o644)
    const env = { AZIGATE_CONFIG_DIR: dir }
    expect(resolveConnection({ secretKey: 'chave-segura', env })).toEqual({ url: 'https://agentes.exemplo.com', key: 'chave-segura' })
    expect(() => resolveConnection({ env })).toThrow(/0600/u)
    chmodSync(join(dir, 'agent.key'), 0o600)
    expect(resolveConnection({ env, urlOverride: 'http://127.0.0.1:9' })).toEqual({ url: 'http://127.0.0.1:9', key: 'chave-em-arquivo' })
    expect(() => resolveConnection({ env: { AZIGATE_CONFIG_DIR: tempDir('azvsc-') } })).toThrow(/Chave do agentd ausente/u)
  })

  it('lê workspace.json e pré-seleciona o workspace da pasta aberta', () => {
    const dir = tempDir('azvsc-')
    const root = tempDir('azvsc-root-')
    const nested = join(root, 'pacotes', 'api')
    mkdirSync(nested, { recursive: true })
    expect(loadLocalWorkspaces({ AZIGATE_CONFIG_DIR: dir }).exists).toBe(false)
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ workspaces: { monorepo: { path: root }, api: { path: nested } } }))
    const local = loadLocalWorkspaces({ AZIGATE_CONFIG_DIR: dir })
    expect([...local.workspaces.keys()]).toEqual(['monorepo', 'api'])
    expect(workspaceForFolders(local.workspaces, [join(nested, '..', 'api')])).toBe('api')
    expect(workspaceForFolders(local.workspaces, [join(root, 'pacotes')])).toBe('monorepo')
    expect(workspaceForFolders(local.workspaces, [tempDir('azvsc-fora-'), '/caminho/inexistente'])).toBeUndefined()
    writeFileSync(join(dir, 'workspace.json'), '{')
    expect(() => loadLocalWorkspaces({ AZIGATE_CONFIG_DIR: dir })).toThrow(/JSON inválido/u)
  })
})

describe('extensão VS Code — SessionController', () => {
  async function ready(api: FakeApi, options: ConstructorParameters<typeof SessionController>[1] = { localWorkspaces: ['meu-projeto'] }) {
    const view = recorder()
    const approvals: string[] = []
    const server: string[] = []
    const controller = new SessionController(
      {
        post: view.post,
        approvalRequested: (id, label) => approvals.push(`${id}:${label}`),
        startServer: () => server.push('start'),
        stopServer: () => server.push('stop'),
      },
      options,
    )
    await controller.setApi(api)
    return { controller, view, approvals, server }
  }

  it('cria a sessão só com IDs, mostra streaming, ferramenta, aprovação e uso', async () => {
    const api = new FakeApi()
    const { controller, view, approvals } = await ready(api)
    expect(lastState(view.messages)).toMatchObject({
      workspace: 'meu-projeto',
      workspaceWorker: 'maquina-b',
      connection: { ok: true },
      providers: [
        { id: 'claude', available: true },
        { id: 'codex', available: false },
        { id: 'agy', available: undefined },
      ],
    })

    await controller.handle({ type: 'send', text: 'analise o projeto' })
    expect(api.calls.find((call) => call.method === 'createSession')?.args[0]).toEqual({ provider: 'claude', workspace: 'meu-projeto', worker: 'maquina-b' })
    expect(lastState(view.messages).busy).toBe(true)

    api.push({ event: 'turn.started' })
    api.push({ event: 'message.delta', text: 'Vou ' })
    api.push({ event: 'message.delta', text: 'analisar.' })
    api.push({ event: 'message.delta', turnId: 'outro', text: 'ignorado' })
    api.push({ event: 'tool.started', tool: 'mcp__azigate_workspace__read_file', summary: 'package.json' })
    api.push({ event: 'tool.completed', tool: 'mcp__azigate_workspace__read_file', status: 'completed' })
    api.push({ event: 'tool.completed', tool: 'mcp__azigate_workspace__git_diff', status: 'failed' })
    api.push({ event: 'subagent.started' })
    api.push({ event: 'subagent.completed' })
    api.push({ event: 'approval.required', approvalId: 'apr_1', tool: 'mcp__azigate_workspace__shell_exec', summary: 'npm test' })
    await waitFor(() => approvals.length === 1)
    expect(approvals).toEqual(['apr_1:RUN npm test'])

    await controller.handle({ type: 'decide', approvalId: 'apr_1', decision: 'allow' })
    await controller.handle({ type: 'decide', approvalId: 'apr_1', decision: 'deny' })
    await controller.handle({ type: 'decide', approvalId: 'apr_inventada', decision: 'allow' })
    expect(api.calls.filter((call) => call.method === 'decide').map((call) => call.args)).toEqual([['apr_1', 'allow']])

    api.push({ event: 'approval.required', approvalId: 'apr_2', tool: 'mcp__azigate_workspace__delete', summary: 'x' })
    api.push({ event: 'approval.resolved', approvalId: 'apr_2', reason: 'timeout', decision: 'deny' })
    api.push({ event: 'usage', usage: { inputTokens: 5, outputTokens: 3 } })
    api.push({ event: 'turn.completed' })
    await waitFor(() => !lastState(view.messages).busy)
    await controller.handle({ type: 'decide', approvalId: 'apr_2', decision: 'allow' })
    expect(api.count('decide')).toBe(1)

    expect(view.entries()).toEqual([
      'user:analise o projeto',
      expect.stringMatching(/^info:Sessão agt_1: Claude em meu-projeto \(maquina-b\)\./u),
      'agent:Claude',
      'delta:Vou ',
      'delta:analisar.',
      'tool:READ package.json',
      'tool-failed:GIT DIFF',
      'info:⤷ subagente iniciado',
      'info:⤶ subagente concluído',
      'approval:RUN npm test',
      'resolved:✓ aprovado',
      'approval:DELETE x',
      'resolved:• aprovação expirada (negada)',
      'usage:tokens: entrada 5 · saída 3',
    ])

    await controller.dispose()
    expect(api.calls.filter((call) => call.method === 'close').map((call) => call.args)).toEqual([['agt_1']])
  })

  it('tolera aprovação já resolvida e reporta outros erros de decisão', async () => {
    const api = new FakeApi()
    const { controller, view } = await ready(api)
    await controller.handle({ type: 'send', text: 'oi' })
    api.decideError = new AgentApiError(409, 'approval_already_resolved', 'já resolvida')
    api.push({ event: 'approval.required', approvalId: 'apr_1', tool: 't' })
    await waitFor(() => view.messages.some((message) => message.type === 'approval'))
    await controller.decide('apr_1', 'deny')
    expect(view.entries()).toContain('resolved:✗ negado')
    api.decideError = new AgentApiError(500, 'internal', 'falhou')
    api.push({ event: 'approval.required', approvalId: 'apr_2', tool: 't' })
    await waitFor(() => view.messages.filter((message) => message.type === 'approval').length === 2)
    await controller.decide('apr_2', 'allow')
    expect(view.entries()).toContain('error:não foi possível registrar a decisão: internal: falhou')
    await controller.dispose()
  })

  it('recusa enviar sem Workspace Server, com dois servidores ou com turno em andamento', async () => {
    const api = new FakeApi()
    api.workerList = []
    const { controller, view } = await ready(api)
    await controller.handle({ type: 'send', text: 'oi' })
    expect(view.entries().at(-1)).toMatch(/Nenhum Workspace Server conectado expõe "meu-projeto"/u)
    expect(lastState(view.messages).busy).toBe(false)

    api.workerList = [
      { id: 'b1', workspaces: ['meu-projeto'], capabilities: [] },
      { id: 'b2', workspaces: ['meu-projeto'], capabilities: [] },
    ]
    await controller.handle({ type: 'send', text: 'oi' })
    expect(view.entries().at(-1)).toMatch(/Mais de um Workspace Server/u)

    api.workerList = [{ id: 'maquina-b', workspaces: ['meu-projeto'], capabilities: [] }]
    await controller.handle({ type: 'send', text: 'primeiro' })
    await controller.handle({ type: 'send', text: 'segundo' })
    expect(view.entries().at(-1)).toBe('error:Há um turno em andamento; cancele ou aguarde.')
    expect(api.count('sendTurn')).toBe(1)

    await controller.handle({ type: 'cancel' })
    expect(api.calls.at(-1)).toEqual({ method: 'cancel', args: ['agt_1'] })
    api.push({ event: 'turn.failed', error: { code: 'turn_cancelled', message: 'cancelado' } })
    await waitFor(() => !lastState(view.messages).busy)
    expect(view.entries()).toContain('error:turno falhou: turn_cancelled — cancelado')
    await controller.dispose()
  })

  it('troca de agente ou workspace encerra a sessão e ignora workspace desconhecido', async () => {
    const api = new FakeApi()
    api.workerList = [{ id: 'maquina-b', workspaces: ['meu-projeto', 'outro'], capabilities: [] }]
    const { controller, view } = await ready(api)
    expect(lastState(view.messages).workspaces).toEqual(['meu-projeto', 'outro'])
    await controller.handle({ type: 'send', text: 'oi' })
    api.push({ event: 'turn.completed' })
    await waitFor(() => !lastState(view.messages).busy)

    await controller.handle({ type: 'selectProvider', provider: 'codex' })
    expect(api.count('close')).toBe(1)
    expect(view.entries().at(-1)).toBe('info:Nova sessão com Codex em meu-projeto.')
    await controller.handle({ type: 'selectWorkspace', workspace: 'inexistente' })
    expect(lastState(view.messages).workspace).toBe('meu-projeto')
    await controller.handle({ type: 'selectWorkspace', workspace: 'outro' })
    expect(lastState(view.messages)).toMatchObject({ provider: 'codex', workspace: 'outro', session: undefined })

    await controller.handle({ type: 'send', text: 'de novo' })
    expect(api.calls.filter((call) => call.method === 'createSession').at(-1)?.args[0]).toEqual({ provider: 'codex', workspace: 'outro', worker: 'maquina-b' })
    await controller.handle({ type: 'newSession' })
    expect(view.messages.at(-2)).toEqual({ type: 'reset' })
    expect(api.count('close')).toBe(2)
    await controller.dispose()
  })

  it('avisa quando o agentd encerra o stream e quando não há conexão', async () => {
    const api = new FakeApi()
    const { controller, view, server } = await ready(api)
    await controller.handle({ type: 'send', text: 'oi' })
    api.endStream()
    await waitFor(() => view.entries().includes('info:A sessão foi encerrada pelo agentd.'))
    expect(lastState(view.messages)).toMatchObject({ busy: false, session: undefined })

    await controller.handle({ type: 'startServer' })
    await controller.handle({ type: 'stopServer' })
    expect(server).toEqual(['start', 'stop'])
    controller.setServerStatus('failed', 'não encontrado')
    expect(lastState(view.messages).server).toEqual({ status: 'failed', detail: 'não encontrado' })

    await controller.setApi(undefined, 'Chave do agentd ausente')
    await controller.handle({ type: 'send', text: 'oi' })
    expect(view.entries().at(-1)).toBe('error:Chave do agentd ausente')
    expect(lastState(view.messages).connection).toEqual({ ok: false, message: 'Chave do agentd ausente' })

    const broken = new FakeApi()
    broken.workers = () => Promise.reject(new AgentApiError(401, 'invalid_agent_key', 'chave inválida'))
    await controller.setApi(broken)
    expect(lastState(view.messages).connection).toEqual({ ok: false, message: 'invalid_agent_key: chave inválida' })
    await controller.dispose()
  })

  it('usa workspaces remotos quando não há workspace.json local', async () => {
    const api = new FakeApi()
    api.workerList = [{ id: 'maquina-b', workspaces: ['remoto'], capabilities: [] }]
    const { controller, view } = await ready(api, {})
    expect(lastState(view.messages)).toMatchObject({ workspaces: ['remoto'], workspace: 'remoto' })
    controller.setLocalWorkspaces(['local'], 'local')
    expect(lastState(view.messages)).toMatchObject({ workspaces: ['local', 'remoto'], workspace: 'remoto' })
    await controller.dispose()
  })
})

describe('extensão VS Code — ponta a ponta com o agentd', () => {
  it('opera o workspace da máquina B pelo Workspace Server e encerra a sessão', async () => {
    const config = loadAgentdConfig({
      AGENT_GATEWAY_ENABLED: 'true',
      AGENT_API_KEYS: KEY,
      AGENT_DATA_DIR: tempDir('azvsc-'),
      CLAUDE_AGENT_ENABLED: 'true',
      WORKER_ENABLED: 'true',
      WORKER_TOKEN_SECRET: SECRET,
    })
    const claude = new ScriptedProvider('claude', true)
    const runtime = await createAgentdApp(config, {
      logger: pino({ level: 'silent' }),
      store: new MemorySessionStore(),
      providers: new Map<AgentProviderId, AgentProvider>([['claude', claude]]),
      localWorkspaces: new Map(),
      mcpBridge: { command: process.execPath, args: ['bridge.js'] },
    })
    cleanups.push(() => runtime.app.close())
    await runtime.app.listen({ host: '127.0.0.1', port: 0 })
    const address = runtime.app.server.address()
    if (!address || typeof address === 'string') throw new Error('endereço inválido')
    const url = `http://127.0.0.1:${address.port}`

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

    const view = recorder()
    const controller = new SessionController({ post: view.post }, { localWorkspaces: ['meu-projeto'] })
    await controller.setApi(new AgentApi(url, KEY))
    expect(lastState(view.messages)).toMatchObject({ workspaceWorker: 'maquina-b', connection: { ok: true } })

    await controller.handle({ type: 'send', text: 'rode os testes' })
    await waitFor(() => claude.runtimes.at(-1)?.inputs.length === 1)
    const agent = claude.last
    expect(agent.options.workspace).toMatchObject({ kind: 'remote', workerId: 'maquina-b', id: 'meu-projeto' })
    agent.push({ event: 'message.delta', text: 'Rodando.', native: {} })
    const decision = agent.context.requestApproval({ tool: 'mcp__azigate_workspace__shell_exec', summary: 'npm test', native: {} })
    await waitFor(() => view.messages.some((message) => message.type === 'approval'))
    const approval = view.messages.find((message) => message.type === 'approval')
    if (!approval || approval.type !== 'approval') throw new Error('sem aprovação')
    await controller.handle({ type: 'decide', approvalId: approval.approvalId, decision: 'allow' })
    await expect(decision).resolves.toBe('allow')
    agent.push({ event: 'turn.completed', native: {} })
    await waitFor(() => !lastState(view.messages).busy)
    expect(view.entries()).toEqual(expect.arrayContaining(['agent:Claude', 'delta:Rodando.', 'approval:RUN npm test', 'resolved:✓ aprovado']))

    const sessionId = lastState(view.messages).session?.id ?? ''
    await controller.dispose()
    expect((await new AgentApi(url, KEY).session(sessionId)).status).toBe('closed')
  })
})

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = undefined
  readonly signals: string[] = []
  kill(signal: string): boolean {
    this.signals.push(signal)
    setImmediate(() => this.emit('exit', null, signal))
    return true
  }
}

describe('extensão VS Code — Workspace Server local', () => {
  it('valida o comando e repassa só o ambiente mínimo', () => {
    expect(validateServerCommand(undefined)).toBe('azigate-workspace')
    expect(validateServerCommand('  ')).toBe('azigate-workspace')
    expect(validateServerCommand('/opt/azigate/bin/azigate-workspace')).toBe('/opt/azigate/bin/azigate-workspace')
    for (const invalid of ['-e', 'azigate-workspace --gateway x', 'a;b', 'npx azigate', '../bin/x']) {
      expect(() => validateServerCommand(invalid)).toThrow()
    }
    expect(minimalEnv({ PATH: '/bin', HOME: '/h', AZIGATE_CONFIG_DIR: '/c', AGENT_API_KEYS: 'x', GITHUB_TOKEN: 'y' })).toEqual({
      PATH: '/bin',
      HOME: '/h',
      AZIGATE_CONFIG_DIR: '/c',
    })
  })

  it('inicia sem shell nem argumentos, encaminha linhas de log e para', async () => {
    const statuses: string[] = []
    const lines: string[] = []
    const spawned: { command: string; args: readonly string[]; options: SpawnOptions }[] = []
    let child = new FakeChild()
    const server = new WorkspaceServerProcess(
      { onStatus: (status, detail) => statuses.push(detail ? `${status}:${detail}` : status), onLog: (line) => lines.push(line) },
      (command, args, options) => {
        spawned.push({ command, args, options })
        child = new FakeChild()
        return child as unknown as ChildProcess
      },
      { PATH: '/bin', SEGREDO: 'nao-repassar' },
    )
    server.start(undefined)
    expect(spawned[0]).toMatchObject({ command: 'azigate-workspace', args: [], options: { shell: false, env: { PATH: '/bin' } } })
    child.emit('spawn')
    child.stdout.write('conectado\nparcial')
    child.stderr.write(` final\r\n${'x'.repeat(2500)}`)
    child.stdout.end()
    child.stderr.end()
    await waitFor(() => lines.length === 3)
    expect(lines[0]).toBe('conectado')
    expect(lines[1]?.length).toBeLessThanOrEqual(2001)
    server.start(undefined)
    expect(spawned).toHaveLength(1)
    server.stop()
    await waitFor(() => statuses.at(-1) === 'stopped')
    expect(child.signals).toEqual(['SIGTERM'])
    expect(statuses).toEqual(['starting', 'running', 'stopped'])
    expect(server.running).toBe(false)

    server.start(undefined)
    const enoent = Object.assign(new Error('spawn azigate-workspace ENOENT'), { code: 'ENOENT' })
    child.emit('error', enoent)
    expect(statuses.at(-1)).toBe('failed:"azigate-workspace" não encontrado; instale o azigate-client')

    server.start(undefined)
    child.emit('spawn')
    child.emit('exit', 1, null)
    expect(statuses.at(-1)).toBe('failed:encerrou (código 1)')

    server.start('npx azigate')
    expect(statuses.at(-1)).toMatch(/^failed:O comando do Workspace Server/u)
  })
})

describe('extensão VS Code — webview e pacote', () => {
  it('renderiza a página com CSP restrita e sem recursos remotos', () => {
    const nonce = createNonce()
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{24}$/u)
    const html = renderWebviewHtml({ nonce, cspSource: 'vscode-webview://x' })
    expect(html).toContain(`default-src 'none'`)
    expect(html).toContain(`script-src 'nonce-${nonce}'`)
    expect(html).toContain(`<script nonce="${nonce}">`)
    expect(html).not.toContain('unsafe-inline')
    expect(html).not.toContain('unsafe-eval')
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|eval\(/u)
    expect(html).not.toMatch(/(src|href)="https?:/u)
  })

  it('declara as configurações sensíveis com escopo machine', () => {
    const manifest = extensionManifest('9.9.9') as {
      extensionKind: string[]
      capabilities: { untrustedWorkspaces: { supported: boolean } }
      contributes: { configuration: { properties: Record<string, { scope: string }> } }
    }
    expect(manifest.extensionKind).toEqual(['workspace'])
    expect(manifest.capabilities.untrustedWorkspaces.supported).toBe(false)
    for (const property of Object.values(manifest.contributes.configuration.properties)) expect(property.scope).toBe('machine')
  })

  it('gera ZIP válido e bundle sem código do Model Plane nem do agentd', async () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
    const zip = createZip([
      { name: 'a.txt', data: Buffer.from('abc') },
      { name: 'pasta/b.txt', data: Buffer.from('') },
    ])
    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    const end = zip.length - 22
    expect(zip.readUInt32LE(end)).toBe(0x06054b50)
    expect(zip.readUInt16LE(end + 10)).toBe(2)
    const centralOffset = zip.readUInt32LE(end + 16)
    expect(zip.readUInt32LE(centralOffset)).toBe(0x02014b50)
    expect(zip.readUInt32LE(centralOffset + 16)).toBe(crc32(Buffer.from('abc')))

    const out = tempDir('azvsc-pack-')
    const { files, dir } = await buildVscodeExtension(out)
    const bundle = files.get('dist/extension.cjs')?.toString('utf8') ?? ''
    expect(bundle).toContain('require("vscode")')
    for (const forbidden of ['DEEPSEEK_API_KEY', 'api.anthropic.com', 'AGENT_API_KEYS=', 'createAgentdApp', 'chatgpt.com/backend-api']) {
      expect(bundle).not.toContain(forbidden)
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { main: string }
    expect(manifest.main).toBe('./dist/extension.cjs')
  })
})
