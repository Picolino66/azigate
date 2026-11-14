import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_URL, resolveClientSettings } from '../src/agent-client/settings.js'
import { buildClientSetupScript, parseClientSetupArgs } from '../src/agentd/client-setup.js'
import { loadWorkerConfig } from '../src/workspace/server/config.js'
import { azigateConfigDir } from '../src/workspace/security/local-files.js'
import { tempDir } from './helpers/agents.js'

const TOKEN = 'token.falso.de-teste'
const KEY = 'chave-falsa-do-agent-plane-0001'

describe('client:setup — argumentos', () => {
  it('aceita worker, vários workspaces id=/caminho, gateway, exec e dias', () => {
    const options = parseClientSetupArgs([
      '--worker', 'maquina-b',
      '--workspace', 'meu-projeto=/home/b/projetos/meu projeto',
      '--workspace', 'outro=/srv/outro',
      '--gateway', 'https://agentes.exemplo.com',
      '--exec', 'npm, git',
      '--days', '30',
      '--with-agent-key',
    ])
    expect(options).toMatchObject({ workerId: 'maquina-b', gateway: 'https://agentes.exemplo.com', days: 30, allowedCommands: ['npm', 'git'], withAgentKey: true })
    expect([...options.workspaces]).toEqual([['meu-projeto', '/home/b/projetos/meu projeto'], ['outro', '/srv/outro']])
  })

  it.each([
    [['--workspace', 'p=/x'], /--worker/u],
    [['--worker', 'b'], /--workspace/u],
    [['--worker', 'b', '--workspace', 'p=relativo'], /absoluto/u],
    [['--worker', 'b', '--workspace', '../p=/x'], /identificador/u],
    [['--worker', 'b', '--workspace', 'p=/x', '--gateway', 'http://10.0.0.5:3100'], /wss:\/\//u],
    [['--worker', 'b', '--workspace', 'p=/x', '--exec', 'rm -rf'], /--exec/u],
    [['--worker', 'b', '--workspace', 'p=/x', '--days', '0'], /--days/u],
    [['--worker', 'b', '--workspace', 'p=/x', '--token', 'x'], /desconhecido/u],
  ])('recusa %j', (argv, message) => {
    expect(() => parseClientSetupArgs(argv)).toThrow(message)
  })
})

describe('client:setup — bloco para a máquina B', () => {
  const run = (script: string, home: string): void => {
    execFileSync('bash', ['-c', script], { cwd: home, env: { PATH: process.env.PATH ?? '', HOME: home }, stdio: 'ignore' })
  }

  it('cria a pasta 0700 e os arquivos 0600 que o Workspace Server e o cliente leem sem flags', () => {
    const home = tempDir('azs-home-')
    const project = join(home, 'meu projeto')
    mkdirSync(project)
    const options = parseClientSetupArgs(['--worker', 'maquina-b', '--workspace', `meu-projeto=${project}`, '--exec', 'npm,git', '--with-agent-key'])
    run(buildClientSetupScript(options, { workspaceToken: TOKEN, agentKey: KEY }), home)
    const dir = join(home, '.config', 'azigate')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    for (const file of ['workspace.token', 'workspace.json', 'agent.json', 'agent.key']) {
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600)
    }
    expect(readFileSync(join(dir, 'workspace.token'), 'utf8').trim()).toBe(TOKEN)

    const env = { HOME: home }
    const config = loadWorkerConfig([], home, env)
    expect(config).toMatchObject({ mode: 'connect', workerId: 'maquina-b', tokenFile: join(dir, 'workspace.token'), exec: { enabled: true } })
    expect(config.mode === 'connect' && config.gatewayUrl.href).toBe('ws://127.0.0.1:3100/worker/v1/connect')
    expect([...config.workspaces]).toEqual([['meu-projeto', realpathSync(project)]])
    expect(resolveClientSettings(env)).toEqual({ url: DEFAULT_AGENT_URL, key: KEY })
  })

  it('sem --with-agent-key não grava a chave, e execução fica desligada sem --exec', () => {
    const home = tempDir('azs-home-')
    run(buildClientSetupScript(parseClientSetupArgs(['--worker', 'b', '--workspace', 'p=/x']), { workspaceToken: TOKEN }), home)
    const dir = join(home, '.config', 'azigate')
    expect(() => statSync(join(dir, 'agent.key'))).toThrow()
    expect(JSON.parse(readFileSync(join(dir, 'workspace.json'), 'utf8'))).toMatchObject({ exec: { enabled: false } })
  })

  it('respeita AZIGATE_CONFIG_DIR e não deixa o umask vazar para o shell de quem colou', () => {
    const home = tempDir('azs-home-')
    const custom = join(home, 'outra-pasta')
    const script = buildClientSetupScript(parseClientSetupArgs(['--worker', 'b', '--workspace', 'p=/x']), { workspaceToken: TOKEN })
    const umask = execFileSync('bash', ['-c', `umask 022\n${script}\numask`], {
      cwd: home,
      env: { PATH: process.env.PATH ?? '', HOME: home, AZIGATE_CONFIG_DIR: custom },
      encoding: 'utf8',
    })
    expect(umask.trim().split('\n').pop()).toBe('0022')
    expect(statSync(join(custom, 'workspace.json')).isFile()).toBe(true)
  })

  it('recusa conteúdo que fecharia o heredoc antes da hora', () => {
    const options = parseClientSetupArgs(['--worker', 'b', '--workspace', 'p=/x'])
    expect(() => buildClientSetupScript(options, { workspaceToken: 'x\nAZIGATE_EOF\nrm -rf ~' })).toThrow(/inesperado/u)
  })
})

describe('azigate-agent — configuração local', () => {
  it('usa variáveis de ambiente antes dos arquivos locais', () => {
    const dir = tempDir('azs-cfg-')
    writeFileSync(join(dir, 'agent.json'), JSON.stringify({ url: 'https://arquivo.exemplo' }))
    writeFileSync(join(dir, 'agent.key'), 'chave-do-arquivo', { mode: 0o600 })
    expect(resolveClientSettings({ AZIGATE_CONFIG_DIR: dir })).toEqual({ url: 'https://arquivo.exemplo', key: 'chave-do-arquivo' })
    expect(resolveClientSettings({ AZIGATE_CONFIG_DIR: dir, AZIGATE_AGENT_URL: 'https://env.exemplo', AZIGATE_AGENT_KEY: 'chave-env' }))
      .toEqual({ url: 'https://env.exemplo', key: 'chave-env' })
    expect(resolveClientSettings({ AZIGATE_CONFIG_DIR: tempDir() })).toEqual({ url: DEFAULT_AGENT_URL, key: undefined })
  })

  it('recusa chave legível por outros usuários e agent.json inválido', () => {
    const dir = tempDir('azs-cfg-')
    writeFileSync(join(dir, 'agent.key'), 'chave')
    chmodSync(join(dir, 'agent.key'), 0o644)
    expect(() => resolveClientSettings({ AZIGATE_CONFIG_DIR: dir })).toThrow(/0600/u)
    expect(() => resolveClientSettings({ AZIGATE_AGENT_KEY_FILE: join(dir, 'agent.key') })).toThrow(/0600/u)
    writeFileSync(join(dir, 'agent.json'), '{')
    expect(() => resolveClientSettings({ AZIGATE_CONFIG_DIR: dir, AZIGATE_AGENT_KEY: 'k' })).toThrow(/JSON inválido/u)
    writeFileSync(join(dir, 'agent.json'), '{}')
    expect(() => resolveClientSettings({ AZIGATE_CONFIG_DIR: dir, AZIGATE_AGENT_KEY: 'k' })).toThrow(/url/u)
  })

  it('pasta padrão: AZIGATE_CONFIG_DIR, depois XDG_CONFIG_HOME, depois ~/.config', () => {
    expect(azigateConfigDir({ AZIGATE_CONFIG_DIR: '/cfg' })).toBe('/cfg')
    expect(azigateConfigDir({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/azigate')
    expect(azigateConfigDir({})).toMatch(/\.config\/azigate$/u)
  })
})
