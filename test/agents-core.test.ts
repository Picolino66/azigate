import { execFile, spawn } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { defaultMcpBridgeLaunch } from '../src/agentd/mcp-bridge-launch.js'
import { AsyncQueue } from '../src/agents/core/async-queue.js'
import { isId, newId } from '../src/agents/core/ids.js'
import { JsonRpcClosedError, JsonRpcConnection, JsonRpcRemoteError, JsonRpcTimeoutError } from '../src/agents/core/json-rpc.js'
import { LineSplitter, parseJsonLine } from '../src/agents/core/ndjson.js'
import { ManagedProcess, minimalEnv } from '../src/agents/core/process.js'
import { WORKER_METHODS } from '../src/workspace/protocol/protocol.js'
import { verifyWorkerToken } from '../src/workspace/security/token.js'
import { WorkerHandler } from '../src/workspace/server/handler.js'
import { tempDir } from './helpers/agents.js'

const run = promisify(execFile)
const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url))
const source = (path: string): string => fileURLToPath(new URL(`../src/${path}`, import.meta.url))

describe('LineSplitter', () => {
  it('separa linhas, remove CR, ignora vazias e descarta linha acima do limite', () => {
    const lines: string[] = []
    let oversized = 0
    const splitter = new LineSplitter(10, (line) => lines.push(line), () => (oversized += 1))
    splitter.push(Buffer.from('um\r\ndo'))
    splitter.push(Buffer.from('is\n\n   \n'))
    splitter.push(Buffer.from('longa-demais-aqui'))
    splitter.push(Buffer.from('-ainda\ntres\nfim'))
    splitter.flush()
    expect(lines).toEqual(['um', 'dois', 'tres', 'fim'])
    expect(oversized).toBe(1)
    const multibyte: string[] = []
    const utf8 = new LineSplitter(100, (line) => multibyte.push(line), () => undefined)
    const bytes = Buffer.from('ação\n')
    utf8.push(bytes.subarray(0, 2))
    utf8.push(bytes.subarray(2))
    expect(multibyte).toEqual(['ação'])
    expect(parseJsonLine('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonLine('{')).toBeUndefined()
  })
})

describe('JsonRpcConnection', () => {
  it('correlaciona respostas, notificações e pedidos do servidor', async () => {
    const sent: Record<string, unknown>[] = []
    const notifications: string[] = []
    const requests: string[] = []
    let invalid = 0
    const rpc = new JsonRpcConnection((message) => sent.push(message) > 0, {
      onNotification: (method) => notifications.push(method),
      onServerRequest: (_id, method) => requests.push(method),
      onInvalidMessage: () => (invalid += 1),
    })
    const ok = rpc.request('initialize', { a: 1 }, 1000)
    const failing = rpc.request('thread/start', {}, 1000)
    rpc.handleMessage({ id: 1, result: { pronto: true } })
    rpc.handleMessage({ id: 2, error: { code: -32001, message: 'x' } })
    await expect(ok).resolves.toEqual({ pronto: true })
    await expect(failing).rejects.toBeInstanceOf(JsonRpcRemoteError)
    rpc.handleMessage({ method: 'turn/started', params: {} })
    rpc.handleMessage({ id: 'srv', method: 'item/tool/call', params: {} })
    rpc.handleMessage({ id: 99, result: {} })
    rpc.handleMessage({ sem: 'campos' })
    rpc.handleMessage('texto')
    expect(notifications).toEqual(['turn/started'])
    expect(requests).toEqual(['item/tool/call'])
    expect(invalid).toBe(2)
    rpc.notify('initialized')
    rpc.respond('srv', { ok: true })
    rpc.respondError('srv', -32601, 'não')
    expect(sent.slice(2)).toEqual([{ method: 'initialized' }, { id: 'srv', result: { ok: true } }, { id: 'srv', error: { code: -32601, message: 'não' } }])
  })

  it('expira, fecha e recusa envio quando o canal cai', async () => {
    const rpc = new JsonRpcConnection(() => true, { onNotification: () => undefined, onServerRequest: () => undefined, onInvalidMessage: () => undefined })
    await expect(rpc.request('lento', {}, 5)).rejects.toBeInstanceOf(JsonRpcTimeoutError)
    const pending = rpc.request('pendente', {}, 1000)
    rpc.close()
    await expect(pending).rejects.toBeInstanceOf(JsonRpcClosedError)
    await expect(rpc.request('depois', {}, 1000)).rejects.toBeInstanceOf(JsonRpcClosedError)
    const broken = new JsonRpcConnection(() => false, { onNotification: () => undefined, onServerRequest: () => undefined, onInvalidMessage: () => undefined })
    await expect(broken.request('x', {}, 1000)).rejects.toBeInstanceOf(JsonRpcClosedError)
  })
})

describe('ManagedProcess', () => {
  it('escala SIGINT → SIGTERM → SIGKILL no grupo de processos', async () => {
    const lines: string[] = []
    const managed = new ManagedProcess(
      {
        command: process.execPath,
        args: ['-e', 'process.on("SIGINT",()=>{});process.on("SIGTERM",()=>{});console.log("pronto");setInterval(()=>{},1000)'],
        cwd: tempDir(),
        env: minimalEnv(process.env),
        maxLineBytes: 1024,
      },
      { onLine: (line) => lines.push(line) },
    )
    managed.start()
    expect(() => managed.start()).toThrow()
    while (lines.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(managed.pid).toBeGreaterThan(0)
    const exit = await managed.terminate({ initialSignal: 'SIGINT', graceMs: 100 })
    expect(exit.signal).toBe('SIGKILL')
    expect(managed.exited).toBe(true)
    expect(managed.writeLine({ tarde: true })).toBe(false)
    managed.signal('SIGTERM')
    expect(await managed.terminate()).toEqual(exit)
  })

  it('reporta falha de spawn e conta bytes de stderr sem guardá-los', async () => {
    const errors: string[] = []
    const missing = new ManagedProcess(
      { command: '/nao/existe', args: [], cwd: tempDir(), env: {}, maxLineBytes: 10 },
      { onLine: () => undefined, onSpawnError: (error) => errors.push(error.name) },
    )
    missing.start()
    await missing.waitForExit()
    expect(errors).toEqual(['Error'])

    const noisy = new ManagedProcess(
      { command: process.execPath, args: ['-e', 'process.stderr.write("x".repeat(100))'], cwd: tempDir(), env: minimalEnv(process.env), maxLineBytes: 10 },
      { onLine: () => undefined },
    )
    noisy.start()
    await noisy.waitForExit()
    expect(noisy.stderrBytes).toBe(100)
    expect(await new ManagedProcess({ command: 'x', args: [], cwd: '/', env: {}, maxLineBytes: 1 }, { onLine: () => undefined }).terminate()).toEqual({ code: null, signal: null })
  })
})

describe('utilitários do núcleo', () => {
  it('fila assíncrona entrega em ordem e encerra', async () => {
    const queue = new AsyncQueue<number>()
    queue.push(1)
    const iterator = queue[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false })
    const waiting = iterator.next()
    queue.push(2)
    await expect(waiting).resolves.toEqual({ value: 2, done: false })
    queue.end()
    queue.push(3)
    expect(queue.isEnded).toBe(true)
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true })
    const early = new AsyncQueue<number>()
    const pending = early[Symbol.asyncIterator]().next()
    early.end()
    await expect(pending).resolves.toEqual({ value: undefined, done: true })
  })

  it('gera e valida identificadores prefixados', () => {
    const id = newId('apr')
    expect(isId('apr', id)).toBe(true)
    expect(isId('agt', id)).toBe(false)
  })

  it('lança a ponte MCP pelo fonte TypeScript quando não há build ao lado', () => {
    const launch = defaultMcpBridgeLaunch()
    expect(launch.command).toBe(process.execPath)
    expect(launch.args).toEqual(['--import', import.meta.resolve('tsx'), source('agentd/mcp-bridge/main.ts')])
  })

  it('despacha todos os métodos do worker', async () => {
    const root = tempDir()
    writeFileSync(join(root, 'a.txt'), 'x')
    const handler = new WorkerHandler(new Map([['w', root]]), { enabled: true, allowedCommands: new Set([process.execPath]) })
    const params: Record<string, Record<string, unknown>> = {
      list_directory: {},
      find_file: { pattern: '*.txt' },
      search: { query: 'x' },
      read_file: { path: 'a.txt' },
      write_file: { path: 'b.txt', content: 'y' },
      edit_file: { path: 'b.txt', oldText: 'y', newText: 'z' },
      mkdir: { path: 'dir' },
      delete: { path: 'dir' },
      shell_exec: { argv: [process.execPath, '-e', '0'] },
      process_start: { argv: [process.execPath, '-e', 'setTimeout(()=>{},200)'] },
    }
    for (const method of WORKER_METHODS) {
      if (method.startsWith('git_') || ['process_stdin', 'process_output', 'process_kill'].includes(method)) continue
      await expect(handler.handle('w', method, params[method] ?? {})).resolves.toBeDefined()
    }
    const started = (await handler.handle('w', 'process_start', { argv: [process.execPath, '-e', 'process.stdin.resume()'] })) as { processId: string }
    await expect(handler.handle('w', 'process_stdin', { processId: started.processId, data: 'a', close: true })).resolves.toEqual({ written: 1 })
    await expect(handler.handle('w', 'process_output', { processId: started.processId })).resolves.toBeDefined()
    await expect(handler.handle('w', 'process_kill', { processId: started.processId })).resolves.toBeDefined()
    await expect(handler.handle('w', 'git_status', {})).rejects.toMatchObject({ code: 'io_error' })
    await expect(handler.handle('w', 'git_diff', {})).rejects.toMatchObject({ code: 'io_error' })
    await expect(handler.handle('w', 'git_log', {})).rejects.toMatchObject({ code: 'io_error' })
    handler.shutdown()
  })
})

describe('entrypoints de CLI (subprocesso)', () => {
  it('worker:token gera token verificável e recusa argumentos inválidos', async () => {
    const secret = 'segredo-de-worker-com-mais-de-32-caracteres'
    const cwd = tempDir()
    const env = { PATH: process.env.PATH ?? '', WORKER_TOKEN_SECRET: secret }
    const { stdout } = await run(tsx, [source('agentd/worker-token.ts'), '--worker', 'devbox', '--workspace', 'backend', '--days', '1'], { cwd, env })
    expect(verifyWorkerToken(secret, stdout.trim())?.workerId).toBe('devbox')
    await expect(run(tsx, [source('agentd/worker-token.ts'), '--workspace', 'backend'], { cwd, env })).rejects.toMatchObject({ code: 1 })
    await expect(run(tsx, [source('agentd/worker-token.ts'), '--worker', 'w', '--workspace', 'b'], { cwd, env: { PATH: env.PATH } })).rejects.toMatchObject({
      code: 1,
    })
  }, 30_000)

  it('azigate-worker recusa token em argv e configuração ausente', async () => {
    const result = await run(tsx, [source('worker/main.ts'), '--token', 'abc'], { cwd: tempDir() }).catch((error: unknown) => error as { code: number; stderr: string })
    expect(result).toMatchObject({ code: 1 })
    expect((result as { stderr: string }).stderr).toContain('--token-file')
  }, 30_000)

  it('azigate-mcp-bridge repassa MCP de forma transparente ao relay, autenticando pelo arquivo de sessão', async () => {
    const directory = tempDir('azb-')
    const socketPath = join(directory, 's.sock')
    const received: Record<string, unknown>[] = []
    const server = createServer((socket) => {
      socket.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
          const message = JSON.parse(line) as Record<string, unknown>
          received.push(message)
          if (typeof message.id === 'number') socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { eco: message.method } })}\n`)
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    const sessionFile = join(directory, 'mcp-session.json')
    writeFileSync(sessionFile, JSON.stringify({ socket: socketPath, token: 'token-da-sessao' }), { mode: 0o600 })
    const bridge = spawn(tsx, [source('agentd/mcp-bridge/main.ts')], {
      env: { PATH: process.env.PATH ?? '', AZIGATE_MCP_SESSION: sessionFile },
    })
    const output: string[] = []
    bridge.stdout.on('data', (chunk: Buffer) => output.push(...chunk.toString('utf8').split('\n').filter(Boolean)))
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`)
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a' } } })}\n`)
    while (output.length < 2) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(output.map((line) => JSON.parse(line) as unknown)).toEqual([
      { jsonrpc: '2.0', id: 1, result: { eco: 'initialize' } },
      { jsonrpc: '2.0', id: 2, result: { eco: 'tools/call' } },
    ])
    expect(received[0]).toEqual({ type: 'hello', token: 'token-da-sessao' })
    expect(received[2]).toEqual({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a' } } })
    const exited = new Promise((resolve) => bridge.once('exit', resolve))
    bridge.stdin.end()
    expect(await exited).toBe(0)
    server.close()

    const open = join(directory, 'aberto.json')
    writeFileSync(open, JSON.stringify({ socket: socketPath, token: 'x' }), { mode: 0o644 })
    chmodSync(open, 0o644)
    const insecure = await run(tsx, [source('agentd/mcp-bridge/main.ts')], { env: { PATH: process.env.PATH ?? '', AZIGATE_MCP_SESSION: open } }).catch(
      (error: unknown) => error as { code: number; stderr: string },
    )
    expect(insecure).toMatchObject({ code: 2 })
  }, 30_000)

  it('azigate-workspace --mcp-stdio serve o workspace a um cliente MCP local, sem gateway', async () => {
    const root = tempDir('azw-')
    writeFileSync(join(root, 'local.txt'), 'conteúdo local de B')
    const configFile = join(tempDir(), 'workspace.json')
    writeFileSync(configFile, JSON.stringify({ workspaces: { projeto: { path: root } } }))
    const server = spawn(tsx, [source('workspace/server/main.ts'), '--config', configFile, '--mcp-stdio', '--workspace', 'projeto'], {
      env: { PATH: process.env.PATH ?? '' },
    })
    const output: string[] = []
    server.stdout.on('data', (chunk: Buffer) => output.push(...chunk.toString('utf8').split('\n').filter(Boolean)))
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`)
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'local.txt' } } })}\n`)
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: '../fora' } } })}\n`)
    while (output.length < 3) await new Promise((resolve) => setTimeout(resolve, 20))
    const replies = output.map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> })
    expect(replies.find((reply) => reply.id === 2)?.result).toEqual({ content: [{ type: 'text', text: 'conteúdo local de B' }], isError: false })
    expect(replies.find((reply) => reply.id === 3)?.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('path_outside_workspace') as unknown }] })
    const exited = new Promise((resolve) => server.once('exit', resolve))
    server.stdin.end()
    expect(await exited).toBe(0)
  }, 30_000)

  it('azigate-workspace --mcp-stdio responde o que já recebeu mesmo com o stdin fechado logo em seguida', async () => {
    const root = tempDir('azw-')
    writeFileSync(join(root, 'local.txt'), 'conteúdo local de B')
    const configFile = join(tempDir(), 'workspace.json')
    writeFileSync(configFile, JSON.stringify({ workspaces: { projeto: { path: root } } }))
    const server = spawn(tsx, [source('workspace/server/main.ts'), '--config', configFile, '--mcp-stdio', '--workspace', 'projeto'], {
      env: { PATH: process.env.PATH ?? '' },
    })
    let output = ''
    server.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    const exited = new Promise((resolve) => server.once('exit', resolve))
    server.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'local.txt' } } })}\n`)
    expect(await exited).toBe(0)
    expect(JSON.parse(output.trim())).toMatchObject({ id: 1, result: { content: [{ text: 'conteúdo local de B' }] } })
  }, 30_000)

  it('azigate-mcp-bridge sem sessão do Azigate expõe zero ferramentas (uso fora do Azigate)', async () => {
    const bridge = spawn(tsx, [source('agentd/mcp-bridge/main.ts')], { env: { PATH: process.env.PATH ?? '' } })
    const output: string[] = []
    bridge.stdout.on('data', (chunk: Buffer) => output.push(...chunk.toString('utf8').split('\n').filter(Boolean)))
    for (const [id, method] of [[1, 'server/discover'], [2, 'initialize'], [3, 'tools/list'], [4, 'tools/call']] as const) {
      bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })}\n`)
    }
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    while (output.length < 4) await new Promise((resolve) => setTimeout(resolve, 20))
    const replies = output.map((line) => JSON.parse(line) as { id: number; result?: Record<string, unknown>; error?: unknown })
    expect(replies.find((reply) => reply.id === 1)?.result).toEqual({})
    expect(replies.find((reply) => reply.id === 2)?.result).toMatchObject({ serverInfo: { name: 'azigate-workspace' } })
    expect(replies.find((reply) => reply.id === 3)?.result).toEqual({ tools: [] })
    expect(replies.find((reply) => reply.id === 4)?.error).toMatchObject({ code: -32601 })
    const exited = new Promise((resolve) => bridge.once('exit', resolve))
    bridge.stdin.end()
    expect(await exited).toBe(0)
  }, 30_000)
})
