import { accessSync, chmodSync, constants, existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute } from 'node:path'
import type { CliProviderName } from './protocol.js'
import type { BrokerConfig } from './config.js'

export interface IsolationCommand {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export function resolveExecutable(configuredPath: string): string {
  if (!isAbsolute(configuredPath)) throw new Error('O path do executável CLI deve ser absoluto')
  accessSync(configuredPath, constants.X_OK)
  return realpathSync(configuredPath)
}

export function hardenAuthDirectory(path: string): string {
  const resolved = realpathSync(path)
  if (!statSync(resolved).isDirectory()) throw new Error('O diretório de autenticação CLI é inválido')
  chmodSync(resolved, 0o700)
  if ((statSync(resolved).mode & 0o077) !== 0) throw new Error('O diretório de autenticação CLI não está privado')
  return resolved
}

export function validatePrivateAuthFile(path: string): string {
  const resolved = realpathSync(path)
  const details = statSync(resolved)
  if (!details.isFile() || details.size > 1_048_576) {
    throw new Error('O arquivo de configuração CLI é inválido')
  }
  const currentUid = process.getuid?.()
  if (currentUid !== undefined && details.uid !== currentUid) {
    throw new Error('O arquivo de configuração CLI pertence a outro usuário')
  }
  if ((details.mode & 0o077) !== 0) {
    throw new Error('O arquivo de configuração CLI não está privado')
  }
  accessSync(resolved, constants.R_OK)
  return resolved
}

function systemBind(args: string[], path: string): void {
  if (existsSync(path)) args.push('--ro-bind', path, path)
}

export function buildIsolationCommand(
  config: BrokerConfig,
  provider: CliProviderName,
  binaryPath: string,
  authDir: string,
  workspace: string,
  cliArgs: readonly string[],
  ephemeralHome?: string,
): IsolationCommand {
  if (provider === 'claude' && ephemeralHome === undefined) {
    throw new Error('O home efêmero do Claude é obrigatório')
  }
  const bwrap = resolveExecutable(config.bwrapPath)
  const args = [
    '--unshare-all',
    '--share-net',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
  ]
  systemBind(args, '/usr')
  systemBind(args, '/bin')
  systemBind(args, '/lib')
  systemBind(args, '/lib64')
  args.push('--dir', '/etc', '--dir', '/etc/ssl')
  systemBind(args, '/etc/resolv.conf')
  systemBind(args, '/etc/hosts')
  systemBind(args, '/etc/nsswitch.conf')
  systemBind(args, '/etc/passwd')
  systemBind(args, '/etc/group')
  systemBind(args, '/etc/ssl/certs')
  systemBind(args, '/etc/pki')
  args.push(
    '--proc', '/proc',
    '--dev', '/dev',
    '--dir', '/home',
    ...(ephemeralHome === undefined
      ? ['--dir', '/home/agent']
      : ['--bind', ephemeralHome, '/home/agent']),
    '--dir', '/opt',
    '--dir', '/opt/cli',
    '--bind', workspace, '/work',
    '--tmpfs', '/tmp',
  )

  const authDestination = `/home/agent/.${provider}`
  args.push('--bind', authDir, authDestination)
  let command = binaryPath
  if (!binaryPath.startsWith('/usr/') && !binaryPath.startsWith('/bin/')) {
    command = `/opt/cli/${provider}-${basename(binaryPath)}`
    args.push('--ro-bind', binaryPath, command)
  }
  args.push(
    '--chdir', '/work',
    '--setenv', 'HOME', '/home/agent',
    '--setenv', 'PATH', '/opt/cli:/usr/local/bin:/usr/bin:/bin',
    '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'LC_ALL', 'C.UTF-8',
    '--setenv', 'TERM', 'dumb',
    '--setenv', 'NO_COLOR', '1',
  )
  if (provider === 'codex') args.push('--setenv', 'CODEX_HOME', authDestination)
  args.push('--', command, ...cliArgs)
  return {
    command: bwrap,
    args,
    env: {
      PATH: `${dirname(bwrap)}:/usr/bin:/bin`,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    },
  }
}
