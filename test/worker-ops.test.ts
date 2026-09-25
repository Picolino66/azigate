import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkerRpcError } from '../src/worker-protocol/protocol.js'
import {
  deletePath,
  editFile,
  findFile,
  globToRegExp,
  listDirectory,
  makeDirectory,
  readFile,
  search,
  writeFile,
} from '../src/worker/fs-ops.js'
import { gitDiff, gitLog, gitStatus } from '../src/worker/git-ops.js'
import { WorkerHandler } from '../src/worker/handler.js'
import { resolveEntry, resolveInside, toRelative } from '../src/worker/jail.js'
import { ProcessRegistry, shellExec, validateArgv } from '../src/worker/process-ops.js'
import { tempDir } from './helpers/agents.js'

async function rpcError(promise: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof promise === 'function' ? promise() : promise)
  } catch (error) {
    expect(error).toBeInstanceOf(WorkerRpcError)
    return (error as WorkerRpcError).code
  }
  throw new Error('esperava WorkerRpcError')
}

function workspace(): { root: string; outside: string } {
  const base = tempDir('azigate-worker-')
  const root = join(base, 'projeto')
  const outside = join(base, 'fora')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(root, 'src', 'app.ts'), 'linha 1\nconst alvo = 1\nlinha 3\n')
  writeFileSync(join(outside, 'segredo.txt'), 'não pode vazar')
  return { root, outside }
}

describe('jail do workspace', () => {
  it('recusa traversal, absolutos, home, byte nulo e symlink para fora', async () => {
    const { root, outside } = workspace()
    symlinkSync(outside, join(root, 'atalho'))
    symlinkSync(join(outside, 'segredo.txt'), join(root, 'link-arquivo'))
    for (const input of ['../fora/segredo.txt', '/etc/passwd', '~/.ssh/id_rsa', 'src/../../fora', 'atalho/segredo.txt', 'link-arquivo', 'atalho/novo.txt']) {
      expect(await rpcError(() => resolveInside(root, input))).toBe('path_outside_workspace')
    }
    expect(await rpcError(() => resolveInside(root, 'a\0b'))).toBe('invalid_params')
    expect(await rpcError(() => resolveInside(root, 42))).toBe('invalid_params')
  })

  it('aceita caminhos internos, inclusive inexistentes e symlink interno', () => {
    const { root } = workspace()
    symlinkSync(join(root, 'src'), join(root, 'codigo'))
    expect(resolveInside(root, undefined)).toBe(root)
    expect(resolveInside(root, '.')).toBe(root)
    expect(resolveInside(root, 'src/novo/arquivo.ts')).toBe(join(root, 'src', 'novo', 'arquivo.ts'))
    expect(resolveInside(root, 'codigo/app.ts')).toBe(join(root, 'src', 'app.ts'))
    expect(toRelative(root, join(root, 'src', 'app.ts'))).toBe('src/app.ts')
    expect(toRelative(root, root)).toBe('.')
    expect(resolveEntry(root, 'codigo')).toBe(join(root, 'codigo'))
  })
})

describe('operações de arquivo', () => {
  it('lista, procura e busca texto literal sem sair do workspace', async () => {
    const { root } = workspace()
    mkdirSync(join(root, 'node_modules', 'pacote'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pacote', 'app.ts'), 'const alvo = 2')
    writeFileSync(join(root, 'binario.bin'), Buffer.from([0, 1, 2, 97, 108, 118, 111]))
    expect(await listDirectory(root, {})).toMatchObject({ truncated: false })
    const listing = (await listDirectory(root, { path: 'src' })) as { entries: { name: string; type: string; size: number }[] }
    expect(listing.entries).toEqual([{ name: 'app.ts', type: 'file', size: 31 }])
    expect(await findFile(root, { pattern: '*.ts' })).toEqual({ paths: ['src/app.ts'], truncated: false })
    expect(await search(root, { query: 'ALVO' })).toEqual({
      matches: [{ path: 'src/app.ts', line: 2, text: 'const alvo = 1' }],
      truncated: false,
    })
    expect(await search(root, { query: 'ALVO', caseSensitive: true })).toEqual({ matches: [], truncated: false })
    expect(await rpcError(search(root, { query: '' }))).toBe('invalid_params')
    expect(await rpcError(findFile(root, { pattern: '*', maxResults: 0 }))).toBe('invalid_params')
    expect(globToRegExp('a?c.*').test('abc.ts')).toBe(true)
    expect(globToRegExp('(x)').test('(x)')).toBe(true)
  })

  it('lê com janela de linhas e recusa diretório', async () => {
    const { root } = workspace()
    expect(await readFile(root, { path: 'src/app.ts' })).toEqual({ content: 'linha 1\nconst alvo = 1\nlinha 3\n', totalBytes: 31, truncated: false })
    expect(await readFile(root, { path: 'src/app.ts', offset: 2, limit: 1 })).toMatchObject({ content: 'const alvo = 1' })
    expect(await rpcError(readFile(root, { path: 'src' }))).toBe('invalid_params')
    expect(await rpcError(readFile(root, { path: 'nao-existe.ts' }))).toBe('not_found')
    expect(await rpcError(readFile(root, {}))).toBe('invalid_params')
  })

  it('escreve, edita com conflito explícito, cria e remove', async () => {
    const { root, outside } = workspace()
    expect(await writeFile(root, { path: 'docs/novo.md', content: 'olá', createDirectories: true })).toEqual({ bytesWritten: 4 })
    expect(await rpcError(writeFile(root, { path: 'x/y.md', content: 'a' }))).toBe('not_found')
    expect(await rpcError(writeFile(root, { path: 'a.md', content: 1 }))).toBe('invalid_params')
    expect(await rpcError(writeFile(root, { path: 'a.md', content: 'x'.repeat(4 * 1024 * 1024 + 1) }))).toBe('too_large')

    writeFileSync(join(root, 'repetido.txt'), 'a a a')
    expect(await rpcError(editFile(root, { path: 'repetido.txt', oldText: 'a', newText: 'b' }))).toBe('conflict')
    expect(await editFile(root, { path: 'repetido.txt', oldText: 'a', newText: 'b', replaceAll: true })).toEqual({ replacements: 3 })
    expect(readFileSync(join(root, 'repetido.txt'), 'utf8')).toBe('b b b')
    expect(await rpcError(editFile(root, { path: 'repetido.txt', oldText: 'z', newText: 'y' }))).toBe('conflict')
    expect(await editFile(root, { path: 'src/app.ts', oldText: 'alvo = 1', newText: 'alvo = $&' })).toEqual({ replacements: 1 })
    expect(readFileSync(join(root, 'src', 'app.ts'), 'utf8')).toContain('alvo = $&')
    expect(await rpcError(editFile(root, { path: 'src/app.ts', oldText: '', newText: 'x' }))).toBe('invalid_params')

    expect(await makeDirectory(root, { path: 'a/b/c' })).toEqual({ created: true })
    expect(await makeDirectory(root, { path: 'a/b/c' })).toEqual({ created: false })
    expect(await rpcError(deletePath(root, { path: 'a' }))).toBe('conflict')
    expect(await deletePath(root, { path: 'a', recursive: true })).toEqual({ deleted: true })
    expect(await rpcError(deletePath(root, { path: '.' }))).toBe('invalid_params')
    expect(await rpcError(deletePath(root, { path: 'src/..' }))).toBe('invalid_params')

    symlinkSync(join(root, 'src', 'app.ts'), join(root, 'link'))
    expect(await deletePath(root, { path: 'link' })).toEqual({ deleted: true })
    expect(existsSync(join(root, 'src', 'app.ts'))).toBe(true)
    expect(existsSync(join(outside, 'segredo.txt'))).toBe(true)
  })
})

describe('execução por argv', () => {
  const allowNode = { enabled: true, allowedCommands: new Set(['node']) }

  it('fica desligada por padrão e respeita a allowlist', async () => {
    const { root } = workspace()
    expect(await rpcError(shellExec(root, { argv: ['node', '-v'] }, { enabled: false }))).toBe('exec_disabled')
    expect(await rpcError(shellExec(root, { argv: ['sh', '-c', 'id'] }, allowNode))).toBe('command_not_allowed')
    expect(await rpcError(() => validateArgv('npm test', allowNode))).toBe('invalid_params')
    expect(await rpcError(() => validateArgv([''], { enabled: true }))).toBe('invalid_params')
    expect(await rpcError(() => validateArgv(['node', 'a\0'], allowNode))).toBe('invalid_params')
  })

  it('executa sem shell, no cwd do workspace, com stdin e timeout', async () => {
    const { root } = workspace()
    const result = (await shellExec(
      root,
      { argv: ['node', '-e', 'process.stdin.pipe(process.stdout); console.error(process.cwd())'], cwd: 'src', stdin: '$(id) && rm -rf /' },
      allowNode,
    )) as Record<string, unknown>
    expect(result).toMatchObject({ exitCode: 0, stdout: '$(id) && rm -rf /', stderr: `${join(root, 'src')}\n`, timedOut: false })
    const slow = (await shellExec(root, { argv: ['node', '-e', 'setTimeout(()=>{},10000)'], timeoutMs: 100 }, allowNode)) as Record<string, unknown>
    expect(slow.timedOut).toBe(true)
    expect(await rpcError(shellExec(root, { argv: ['node'], cwd: '../fora' }, allowNode))).toBe('path_outside_workspace')
    expect(await rpcError(shellExec(root, { argv: ['programa-inexistente-azigate'] }, { enabled: true }))).toBe('not_found')
    expect(await rpcError(shellExec(root, { argv: ['node'], timeoutMs: 0 }, allowNode))).toBe('invalid_params')
    const env = (await shellExec(root, { argv: ['node', '-e', 'console.log(Object.keys(process.env).join(","))'] }, allowNode)) as { stdout: string }
    expect(env.stdout).not.toMatch(/WORKER|TOKEN|SECRET/u)
  })

  it('gerencia processos longos com stdin, saída por cursor e kill', async () => {
    const { root } = workspace()
    const registry = new ProcessRegistry(allowNode)
    const { processId } = registry.start(root, {
      argv: ['node', '-e', 'process.stdin.on("data", d => process.stdout.write("eco:" + d))'],
    }) as { processId: string }
    expect(registry.stdin({ processId, data: 'oi' })).toEqual({ written: 2 })
    await new Promise((resolve) => setTimeout(resolve, 150))
    const first = registry.output({ processId }) as { output: string; cursor: number; running: boolean }
    expect(first).toMatchObject({ output: 'eco:oi', running: true })
    expect(registry.output({ processId, cursor: first.cursor })).toMatchObject({ output: '' })
    expect(registry.kill({ processId, signal: 'SIGKILL' })).toEqual({ killed: true })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(registry.output({ processId })).toMatchObject({ running: false })
    expect(registry.kill({ processId })).toEqual({ killed: false })
    expect(await rpcError(() => registry.stdin({ processId, data: 'x' }))).toBe('conflict')
    expect(await rpcError(() => registry.output({ processId: 'proc_x' }))).toBe('process_not_found')
    expect(await rpcError(() => registry.kill({ processId, signal: 'SIGSTOP' }))).toBe('invalid_params')
    registry.killAll()
  })
})

describe('git endurecido', () => {
  it('lê status, diff e log sem executar configuração do repositório', async () => {
    const { root } = workspace()
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
    }
    git('init', '-q')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'inicial')
    const marker = join(root, 'executado')
    writeFileSync(join(root, 'monitor.sh'), `#!/bin/sh\ntouch ${marker}\n`)
    chmodSync(join(root, 'monitor.sh'), 0o755)
    git('config', 'core.fsmonitor', join(root, 'monitor.sh'))
    git('config', 'diff.external', join(root, 'monitor.sh'))
    writeFileSync(join(root, 'src', 'app.ts'), 'mudou\n')

    expect(((await gitStatus(root)) as { output: string }).output).toContain(' M src/app.ts')
    expect(((await gitDiff(root, { path: 'src/app.ts' })) as { output: string }).output).toContain('+mudou')
    expect(((await gitDiff(root, { staged: true })) as { output: string }).output).toBe('')
    expect(((await gitLog(root, { maxCount: 5 })) as { output: string }).output).toContain('inicial')
    expect(existsSync(marker)).toBe(false)
    expect(await rpcError(gitLog(root, { maxCount: 1000 }))).toBe('invalid_params')
    expect(await rpcError(gitDiff(root, { staged: 'sim' }))).toBe('invalid_params')
  })

  it('não sobe para um repositório fora do workspace', async () => {
    const base = tempDir('azigate-git-')
    execFileSync('git', ['init', '-q'], { cwd: base, stdio: 'ignore' })
    const inner = join(base, 'workspace')
    mkdirSync(inner)
    expect(await rpcError(gitStatus(inner))).toBe('io_error')
  })
})

describe('dispatcher do worker', () => {
  it('encaminha métodos ao workspace certo e recusa workspace desconhecido', async () => {
    const { root } = workspace()
    const handler = new WorkerHandler(new Map([['backend', root]]), { enabled: false })
    expect(handler.workspaceIds).toEqual(['backend'])
    expect(handler.execEnabled).toBe(false)
    expect(await handler.handle('backend', 'read_file', { path: 'src/app.ts' })).toMatchObject({ totalBytes: 31 })
    expect(await rpcError(handler.handle('outro', 'read_file', { path: 'src/app.ts' }))).toBe('workspace_not_found')
    expect(await rpcError(handler.handle('backend', 'shell_exec', { argv: ['ls'] }))).toBe('exec_disabled')
    expect(await rpcError(handler.handle('backend', 'process_output', { processId: 'x' }))).toBe('process_not_found')
    handler.shutdown()
  })
})

describe('regressões de segurança do worker', () => {
  it('não trava ao ler ou buscar um FIFO dentro do workspace', async () => {
    const { root } = workspace()
    execFileSync('mkfifo', [join(root, 'cano')])
    expect(await rpcError(readFile(root, { path: 'cano' }))).toBe('invalid_params')
    expect(await search(root, { query: 'alvo' })).toMatchObject({ truncated: false })
  })

  it('recusa alterar metadados do Git mesmo dentro do workspace', async () => {
    const { root } = workspace()
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'config'), '[core]\n')
    mkdirSync(join(root, 'vendor', 'lib', '.git'), { recursive: true })
    const attempts = [
      writeFile(root, { path: '.git/config', content: '[filter "x"]\n\tclean = ./evil.sh\n' }),
      editFile(root, { path: '.git/config', oldText: '[core]', newText: '[core]\n\tfsmonitor = x' }),
      makeDirectory(root, { path: '.git/hooks' }),
      deletePath(root, { path: '.git/config' }),
      writeFile(root, { path: 'vendor/lib/.git/config', content: 'x' }),
    ]
    for (const attempt of attempts) expect(await rpcError(attempt)).toBe('permission_denied')
    expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe('[core]\n')
    expect(await writeFile(root, { path: '.gitignore', content: 'dist\n' })).toEqual({ bytesWritten: 5 })
  })
})
