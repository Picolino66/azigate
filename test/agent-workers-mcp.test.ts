import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteToolGateway, mcpToolName, READ_ONLY_MCP_TOOLS } from '../src/agent-control/remote-tools.js'
import { WorkerHub } from '../src/agent-control/workers.js'
import { WorkspaceMcpServer, formatToolResult } from '../src/mcp-bridge/mcp-server.js'
import { WorkerRpcError } from '../src/worker-protocol/protocol.js'
import type { WorkerIdentity } from '../src/worker-protocol/security.js'
import type { WorkerSocket } from '../src/worker-protocol/transport.js'

class FakeSocket extends EventEmitter implements WorkerSocket {
  readyState = 1
  sent: Record<string, unknown>[] = []
  closedWith: number | undefined

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(code?: number): void {
    if (this.readyState !== 1) return
    this.readyState = 3
    this.closedWith = code
    this.emit('close', code ?? 1000)
  }

  receive(payload: unknown, isBinary = false): void {
    this.emit('message', Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)), isBinary)
  }
}

const identity: WorkerIdentity = { workerId: 'devbox', workspaces: new Set(['backend']), expiresAt: Date.now() + 60_000 }
const register = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'worker.register',
  protocolVersion: 1,
  workerId: 'devbox',
  workerVersion: '1.0.0',
  capabilities: ['filesystem', 'git'],
  workspaces: ['backend', 'privado'],
  ...overrides,
})

const hubs: WorkerHub[] = []
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.closeAll()
})

function hub(heartbeatIntervalMs = 60_000, registrationTimeoutMs = 60_000): WorkerHub {
  const created = new WorkerHub({ heartbeatIntervalMs, registrationTimeoutMs })
  hubs.push(created)
  return created
}

describe('WorkerHub', () => {
  it('registra somente workspaces do escopo e correlaciona RPCs', async () => {
    const workers = hub()
    const socket = new FakeSocket()
    workers.attach(socket, identity)
    socket.receive(register())
    expect(socket.sent[0]).toEqual({ type: 'worker.registered', workerId: 'devbox', workspaces: ['backend'], heartbeatIntervalMs: 60_000 })
    expect(workers.list()).toEqual([expect.objectContaining({ id: 'devbox', workspaces: ['backend'], capabilities: ['filesystem', 'git'] })])
    expect(workers.hasWorkspace('devbox', 'privado')).toBe(false)

    const call = workers.call('devbox', 'backend', 'read_file', { path: 'a' }, 1000)
    const request = socket.sent[1] as { id: string; method: string; workspace: string }
    expect(request).toMatchObject({ type: 'rpc.request', method: 'read_file', workspace: 'backend' })
    socket.receive({ type: 'rpc.response', id: request.id, ok: true, result: { content: 'x' } })
    await expect(call).resolves.toEqual({ content: 'x' })

    const failing = workers.call('devbox', 'backend', 'read_file', { path: 'b' }, 1000)
    const second = socket.sent[2] as { id: string }
    socket.receive({ type: 'rpc.response', id: second.id, ok: false, error: { code: 'not_found', message: 'sumiu' } })
    await expect(failing).rejects.toMatchObject({ code: 'not_found' })

    await expect(workers.call('devbox', 'privado', 'read_file', {}, 1000)).rejects.toMatchObject({ code: 'workspace_not_found' })
    await expect(workers.call('devbox', 'backend', 'shell_exec', {}, 1000)).rejects.toMatchObject({ code: 'exec_disabled' })
    await expect(workers.call('outro', 'backend', 'read_file', {}, 1000)).rejects.toMatchObject({ code: 'worker_unavailable' })
    await expect(workers.call('devbox', 'backend', 'read_file', {}, 10)).rejects.toMatchObject({ code: 'timeout' })
  })

  it('recusa registro de outro worker, versão errada ou sem workspace autorizado', () => {
    const workers = hub()
    for (const [message, code] of [
      [register({ workerId: 'impostor' }), 'worker_id_mismatch'],
      [register({ protocolVersion: 2 }), 'protocol_version'],
      [register({ workspaces: ['privado'] }), 'no_authorized_workspace'],
    ] as const) {
      const socket = new FakeSocket()
      workers.attach(socket, identity)
      socket.receive(message)
      expect(socket.sent[0]).toMatchObject({ type: 'worker.rejected', code })
      expect(socket.closedWith).toBe(4403)
    }
    expect(workers.list()).toEqual([])
  })

  it('fecha conexões com frame binário, JSON inválido, mensagem fora de ordem ou sem registro', async () => {
    const workers = hub(60_000, 20)
    const binary = new FakeSocket()
    workers.attach(binary, identity)
    binary.receive('{}', true)
    expect(binary.closedWith).toBe(1003)

    const invalid = new FakeSocket()
    workers.attach(invalid, identity)
    invalid.receive('não é json')
    expect(invalid.closedWith).toBe(1003)

    const outOfOrder = new FakeSocket()
    workers.attach(outOfOrder, identity)
    outOfOrder.receive({ type: 'worker.heartbeat' })
    expect(outOfOrder.closedWith).toBe(4403)

    const silent = new FakeSocket()
    workers.attach(silent, identity)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(silent.closedWith).toBe(4403)
  })

  it('substitui conexão duplicada e derruba worker sem heartbeat', async () => {
    const workers = hub(20)
    const first = new FakeSocket()
    workers.attach(first, identity)
    first.receive(register())
    const pending = workers.call('devbox', 'backend', 'read_file', {}, 5000)
    const second = new FakeSocket()
    workers.attach(second, identity)
    second.receive(register({ capabilities: ['filesystem', 'git', 'exec'] }))
    expect(first.closedWith).toBe(4409)
    await expect(pending).rejects.toMatchObject({ code: 'worker_unavailable' })
    expect(workers.list()[0]?.capabilities).toContain('exec')

    second.receive({ type: 'worker.heartbeat' })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(second.closedWith).toBe(4408)
    expect(workers.isConnected('devbox')).toBe(false)
  })
})

describe('RemoteToolGateway', () => {
  it('amarra o token à sessão, aplica o modo plan e revoga no fim', async () => {
    const workers = hub()
    const socket = new FakeSocket()
    workers.attach(socket, identity)
    socket.receive(register())
    const gateway = new RemoteToolGateway(workers)
    const token = gateway.issue({ sessionId: 'agt_1', workerId: 'devbox', workspaceId: 'backend', permissionMode: 'plan' })

    await expect(gateway.call('errado', 'read_file', {})).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(gateway.call(token, 'rm_rf', {})).rejects.toMatchObject({ code: 'method_not_found' })
    await expect(gateway.call(token, 'write_file', { path: 'a', content: 'b' })).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(gateway.call(token, 'shell_exec', { argv: ['ls'] })).rejects.toMatchObject({ code: 'permission_denied' })

    const reading = gateway.call(token, 'read_file', { path: 'a' })
    const request = socket.sent.at(-1) as { id: string; params: unknown }
    expect(request.params).toEqual({ path: 'a' })
    socket.receive({ type: 'rpc.response', id: request.id, ok: true, result: { content: 'ok' } })
    await expect(reading).resolves.toEqual({ content: 'ok' })

    gateway.revokeSession('agt_1')
    await expect(gateway.call(token, 'read_file', {})).rejects.toBeInstanceOf(WorkerRpcError)
  })

  it('publica nomes MCP somente leitura', () => {
    expect(mcpToolName('read_file')).toBe('mcp__azigate_workspace__read_file')
    expect(READ_ONLY_MCP_TOOLS).toContain('mcp__azigate_workspace__git_diff')
    expect(READ_ONLY_MCP_TOOLS).not.toContain('mcp__azigate_workspace__shell_exec')
  })
})

describe('servidor MCP do workspace', () => {
  const calls: [string, Record<string, unknown>][] = []
  const server = new WorkspaceMcpServer(async (tool, args) => {
    calls.push([tool, args])
    if (tool === 'delete') return { ok: false, code: 'permission_denied', message: 'O modo plan permite somente leitura' }
    return { ok: true, result: tool === 'read_file' ? { content: 'conteúdo', truncated: true } : { entries: [] } }
  })

  it('negocia versão, lista ferramentas e responde ping', async () => {
    expect(await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'azigate-workspace' } },
    })
    expect(await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).toMatchObject({
      result: { protocolVersion: '2025-06-18' },
    })
    const list = (await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })) as { result: { tools: { name: string }[] } }
    expect(list.result.tools.map((tool) => tool.name)).toContain('shell_exec')
    expect(await server.handle({ jsonrpc: '2.0', id: 4, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 4, result: {} })
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined()
    expect(await server.handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' })).toMatchObject({ error: { code: -32601 } })
    expect(await server.handle({ id: null })).toMatchObject({ error: { code: -32600 } })
    expect(await server.handle('lixo')).toBeUndefined()
  })

  it('encaminha tools/call e sinaliza erro sem lançar', async () => {
    expect(await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a.ts' } } })).toEqual({
      jsonrpc: '2.0',
      id: 6,
      result: { content: [{ type: 'text', text: 'conteúdo\n\n[conteúdo truncado em 1 MiB]' }], isError: false },
    })
    expect(calls.at(-1)).toEqual(['read_file', { path: 'a.ts' }])
    expect(await server.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'delete', arguments: { path: 'a' } } })).toMatchObject({
      result: { isError: true, content: [{ text: 'permission_denied: O modo plan permite somente leitura' }] },
    })
    expect(await server.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'Bash' } })).toMatchObject({ error: { code: -32602 } })
    expect(formatToolResult('git_status', { output: '## main' })).toBe('## main')
    expect(formatToolResult('git_diff', { output: 'x', truncated: true })).toContain('[saída truncada]')
    expect(formatToolResult('list_directory', { entries: [] })).toBe('{\n  "entries": []\n}')
  })
})

describe('WorkerHub — expiração do token', () => {
  it('derruba a conexão quando o token expira', async () => {
    const workers = hub()
    const socket = new FakeSocket()
    workers.attach(socket, { ...identity, expiresAt: Date.now() + 30 })
    socket.receive(register())
    expect(workers.isConnected('devbox')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(socket.closedWith).toBe(4401)
    expect(workers.isConnected('devbox')).toBe(false)
  })
})
