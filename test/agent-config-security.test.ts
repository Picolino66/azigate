import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadAgentdConfig, parseDuration } from '../src/agentd/config.js'
import { loadWorkspacesFile, parseWorkspaces } from '../src/agent-control/workspaces.js'
import { minimalEnv } from '../src/agents/core/process.js'
import { isCertified, parseVersion } from '../src/agents/core/versions.js'
import { parseGatewayMessage, parseWorkerMessage } from '../src/worker-protocol/protocol.js'
import { bearerToken, signWorkerToken, verifyWorkerToken } from '../src/worker-protocol/security.js'
import { loadWorkerConfig, parseWorkerArgs, readTokenFile, workerConnectUrl } from '../src/worker/config.js'
import { tempDir } from './helpers/agents.js'

const SECRET = 'segredo-de-worker-com-mais-de-32-caracteres'
const AGENT_KEY = 'chave-do-agent-plane-0001'

function agentEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { AGENT_GATEWAY_ENABLED: 'true', AGENT_API_KEYS: AGENT_KEY, ...overrides }
}

describe('token de worker', () => {
  it('assina e valida escopos, expiração e integridade', () => {
    const now = Date.UTC(2026, 8, 25)
    const token = signWorkerToken(SECRET, { workerId: 'devbox', workspaces: ['backend', 'backend', 'front'], ttlSeconds: 60, now })
    const identity = verifyWorkerToken(SECRET, token, now)
    expect(identity).toMatchObject({ workerId: 'devbox' })
    expect([...(identity?.workspaces ?? [])]).toEqual(['backend', 'front'])
    expect(verifyWorkerToken(SECRET, token, now + 61_000)).toBeUndefined()
    expect(verifyWorkerToken(`${SECRET}x`, token, now)).toBeUndefined()
    const [payload, signature] = token.split('.') as [string, string]
    const forged = Buffer.from(JSON.stringify({ v: 1, sub: 'outro', scopes: ['worker:connect', 'workspace:backend'], iat: 0, exp: 9e9 })).toString('base64url')
    expect(verifyWorkerToken(SECRET, `${forged}.${signature}`, now)).toBeUndefined()
    expect(verifyWorkerToken(SECRET, `${payload}.${signature}.extra`, now)).toBeUndefined()
    expect(verifyWorkerToken(SECRET, 'lixo', now)).toBeUndefined()
    expect(verifyWorkerToken(SECRET, `${payload}.!!`, now)).toBeUndefined()
  })

  it('recusa parâmetros inválidos ao gerar', () => {
    expect(() => signWorkerToken('curto', { workerId: 'w', workspaces: ['a'], ttlSeconds: 1 })).toThrow()
    expect(() => signWorkerToken(SECRET, { workerId: '../x', workspaces: ['a'], ttlSeconds: 1 })).toThrow()
    expect(() => signWorkerToken(SECRET, { workerId: 'w', workspaces: [], ttlSeconds: 1 })).toThrow()
    expect(() => signWorkerToken(SECRET, { workerId: 'w', workspaces: ['a b'], ttlSeconds: 1 })).toThrow()
    expect(() => signWorkerToken(SECRET, { workerId: 'w', workspaces: ['a'], ttlSeconds: 0 })).toThrow()
  })

  it('extrai somente Bearer bem formado', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def')
    expect(bearerToken('Basic abc')).toBeUndefined()
    expect(bearerToken(undefined)).toBeUndefined()
  })
})

describe('protocolo do worker', () => {
  it('valida mensagens nas duas direções', () => {
    expect(parseWorkerMessage('{"type":"worker.heartbeat"}')).toEqual({ type: 'worker.heartbeat' })
    expect(
      parseWorkerMessage(JSON.stringify({ type: 'worker.register', protocolVersion: 1, workerId: 'w', workerVersion: '1', capabilities: ['exec', 'root'], workspaces: ['a'] })),
    ).toMatchObject({ capabilities: ['exec'] })
    expect(parseWorkerMessage(JSON.stringify({ type: 'worker.register', workerId: 'w' }))).toBeUndefined()
    expect(parseWorkerMessage(JSON.stringify({ type: 'rpc.response', id: 'r', ok: false, error: { code: 'inventado', message: 'x' } }))).toBeUndefined()
    expect(parseWorkerMessage(JSON.stringify({ type: 'rpc.response', id: 'r', ok: true, result: 1 }))).toEqual({ type: 'rpc.response', id: 'r', ok: true, result: 1 })
    expect(parseWorkerMessage('não é json')).toBeUndefined()
    expect(parseGatewayMessage(JSON.stringify({ type: 'rpc.request', id: 'r', workspace: 'a', method: 'rm_rf', params: {} }))).toBeUndefined()
    expect(parseGatewayMessage(JSON.stringify({ type: 'rpc.request', id: 'r', workspace: 'a', method: 'read_file', params: { path: 'x' } }))).toMatchObject({ method: 'read_file' })
    expect(parseGatewayMessage(JSON.stringify({ type: 'worker.rejected' }))).toEqual({ type: 'worker.rejected', code: 'rejected', message: '' })
    expect(parseGatewayMessage(JSON.stringify({ type: 'worker.registered', workerId: 'w', workspaces: ['a'], heartbeatIntervalMs: 10 }))).toMatchObject({ type: 'worker.registered' })
    expect(parseGatewayMessage(JSON.stringify({ type: 'desconhecido' }))).toBeUndefined()
  })
})

describe('configuração do agentd', () => {
  it('exige habilitação explícita e credenciais separadas', () => {
    expect(() => loadAgentdConfig({ AGENT_API_KEYS: AGENT_KEY })).toThrow(/AGENT_GATEWAY_ENABLED/u)
    expect(() => loadAgentdConfig(agentEnv({ AGENT_API_KEYS: 'curta' }))).toThrow(/16 caracteres/u)
    expect(() => loadAgentdConfig(agentEnv({ GATEWAY_API_KEYS: `outra-chave-do-model-plane,${AGENT_KEY}` }))).toThrow(/credenciais separadas/u)
    expect(() => loadAgentdConfig(agentEnv({ WORKER_ENABLED: 'true' }))).toThrow(/WORKER_TOKEN_SECRET/u)
    expect(() => loadAgentdConfig(agentEnv({ WORKER_ENABLED: 'true', WORKER_TOKEN_SECRET: 'curto' }))).toThrow(/32 caracteres/u)
    expect(() => loadAgentdConfig(agentEnv({ WORKER_ENABLED: 'true', WORKER_TOKEN_SECRET: `${AGENT_KEY}${AGENT_KEY}`, AGENT_API_KEYS: `${AGENT_KEY}${AGENT_KEY}` }))).toThrow(/não pode repetir/u)
    expect(() => loadAgentdConfig(agentEnv({ CLAUDE_BINARY: 'bin/claude' }))).toThrow(/caminho absoluto/u)
    expect(() => loadAgentdConfig(agentEnv({ CLAUDE_BINARY: '--help' }))).toThrow()
    expect(() => loadAgentdConfig(agentEnv({ AGENT_ALLOWED_IPS: 'x' }))).toThrow(/IP inválido/u)
    expect(() => loadAgentdConfig(agentEnv({ AGENT_VERSION_POLICY: 'nunca' }))).toThrow()
    expect(() => loadAgentdConfig(agentEnv({ NODE_ENV: 'staging' }))).toThrow()
  })

  it('aplica padrões seguros e lê limites', () => {
    const config = loadAgentdConfig(agentEnv({ NODE_ENV: 'production', AGENT_SESSION_IDLE_TIMEOUT: '15m', CODEX_AGENT_ENABLED: 'true' }), '/srv/azigate')
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 3100,
      versionPolicy: 'fail-closed',
      dataDir: '/srv/azigate/data/agentd',
      databasePath: '/srv/azigate/data/agentd/agentd.db',
      mcpSocketPath: '/srv/azigate/data/agentd/mcp.sock',
      trustProxy: false,
      providers: { codex: { enabled: true, binary: 'codex' }, claude: { enabled: false }, agy: { enabled: false } },
      worker: { enabled: false },
    })
    expect(config.limits.idleTimeoutMs).toBe(900_000)
    expect(loadAgentdConfig(agentEnv()).versionPolicy).toBe('warn')
    const withWorker = loadAgentdConfig(agentEnv({ WORKER_ENABLED: 'true', WORKER_TOKEN_SECRET: SECRET, AGENT_WORKSPACES_FILE: 'ws.json' }), '/srv')
    expect(withWorker.worker).toMatchObject({ enabled: true, tokenSecret: SECRET, heartbeatIntervalMs: 15_000 })
    expect(withWorker.workspacesFile).toBe('/srv/ws.json')
  })

  it('interpreta durações', () => {
    expect(parseDuration('X', '500ms', 1, 1, 1e9)).toBe(500)
    expect(parseDuration('X', '30s', 1, 1, 1e9)).toBe(30_000)
    expect(parseDuration('X', '1h', 1, 1, 1e9)).toBe(3_600_000)
    expect(parseDuration('X', '250', 1, 1, 1e9)).toBe(250)
    expect(parseDuration('X', undefined, 7, 1, 1e9)).toBe(7)
    expect(() => parseDuration('X', '1d', 1, 1, 1e9)).toThrow()
    expect(() => parseDuration('X', '1s', 1, 5000, 1e9)).toThrow()
  })
})

describe('workspaces', () => {
  it('valida IDs e paths, resolve realpath e recusa a raiz do sistema', () => {
    const base = tempDir()
    mkdirSync(join(base, 'api'))
    writeFileSync(join(base, 'arquivo'), '')
    expect([...parseWorkspaces({ workspaces: { api: { path: join(base, 'api') } } }, 'teste')]).toEqual([['api', join(base, 'api')]])
    expect(() => parseWorkspaces({}, 'teste')).toThrow()
    expect(() => parseWorkspaces({ workspaces: { '../x': { path: base } } }, 'teste')).toThrow()
    expect(() => parseWorkspaces({ workspaces: { api: { path: 'relativo' } } }, 'teste')).toThrow()
    expect(() => parseWorkspaces({ workspaces: { api: { path: join(base, 'nao-existe') } } }, 'teste')).toThrow()
    expect(() => parseWorkspaces({ workspaces: { api: { path: join(base, 'arquivo') } } }, 'teste')).toThrow()
    expect(() => parseWorkspaces({ workspaces: { raiz: { path: '/' } } }, 'teste')).toThrow()
    const file = join(base, 'ws.json')
    writeFileSync(file, JSON.stringify({ workspaces: { api: { path: join(base, 'api') } } }))
    expect(loadWorkspacesFile(file).get('api')).toBe(join(base, 'api'))
    expect(loadWorkspacesFile(undefined).size).toBe(0)
    writeFileSync(file, '{')
    expect(() => loadWorkspacesFile(file)).toThrow()
  })
})

describe('configuração do worker', () => {
  it('exige TLS fora do loopback e anexa o caminho do conector', () => {
    expect(workerConnectUrl('https://ia.example.com').href).toBe('wss://ia.example.com/worker/v1/connect')
    expect(workerConnectUrl('http://127.0.0.1:3100/').href).toBe('ws://127.0.0.1:3100/worker/v1/connect')
    expect(() => workerConnectUrl('http://ia.example.com')).toThrow(/wss/u)
    expect(() => workerConnectUrl('wss://u:p@ia.example.com')).toThrow()
    expect(() => workerConnectUrl('nada')).toThrow()
  })

  it('recusa token em argv e token legível por outros', () => {
    expect(() => parseWorkerArgs(['--token', 'abc'])).toThrow(/--token-file/u)
    expect(() => parseWorkerArgs(['--desconhecido', 'x'])).toThrow()
    expect(parseWorkerArgs(['--config', 'a.json', '--worker', 'w'])).toEqual({ config: 'a.json', worker: 'w' })
    const directory = tempDir()
    const tokenFile = join(directory, 'token')
    writeFileSync(tokenFile, 'abc\n', { mode: 0o644 })
    chmodSync(tokenFile, 0o644)
    expect(() => readTokenFile(tokenFile)).toThrow(/0600/u)
    chmodSync(tokenFile, 0o600)
    expect(readTokenFile(tokenFile)).toBe('abc')
    writeFileSync(tokenFile, '\n')
    expect(() => readTokenFile(tokenFile)).toThrow(/vazio/u)
  })

  it('carrega o arquivo de configuração com exec desligado por padrão', () => {
    const directory = tempDir()
    mkdirSync(join(directory, 'backend'))
    const configFile = join(directory, 'worker.json')
    writeFileSync(
      configFile,
      JSON.stringify({ gateway: 'https://ia.example.com', workerId: 'devbox', tokenFile: 'token', workspaces: { backend: { path: join(directory, 'backend') } } }),
    )
    const config = loadWorkerConfig(['--config', configFile])
    expect(config).toMatchObject({ workerId: 'devbox', tokenFile: join(directory, 'token'), exec: { enabled: false } })
    writeFileSync(
      configFile,
      JSON.stringify({ gateway: 'https://ia.example.com', workerId: 'devbox', tokenFile: '/t', exec: { enabled: true, allowedCommands: ['npm'] }, workspaces: {} }),
    )
    expect(loadWorkerConfig(['--config', configFile]).exec.allowedCommands?.has('npm')).toBe(true)
    writeFileSync(configFile, JSON.stringify({ gateway: 'https://x', workerId: 'w', tokenFile: '/t', exec: { allowedCommands: [1] }, workspaces: {} }))
    expect(() => loadWorkerConfig(['--config', configFile])).toThrow()
    expect(() => loadWorkerConfig([])).toThrow(/--config/u)
    writeFileSync(configFile, JSON.stringify({ workerId: 'w' }))
    expect(() => loadWorkerConfig(['--config', configFile])).toThrow(/gateway/u)
  })
})

describe('núcleo de processos e versões', () => {
  it('monta ambiente mínimo sem segredos', () => {
    const env = minimalEnv(
      { HOME: '/home/op', PATH: '/bin', AGENT_API_KEYS: 'x', WORKER_TOKEN_SECRET: 'y', DEEPSEEK_API_KEY: 'z', CODEX_HOME: '/c' },
      ['CODEX_HOME'],
    )
    expect(env).toEqual({ HOME: '/home/op', PATH: '/bin', CODEX_HOME: '/c', TERM: 'dumb', NO_COLOR: '1' })
  })

  it('extrai versões e compara com a matriz certificada', () => {
    expect(parseVersion('codex-cli 0.144.6')).toBe('0.144.6')
    expect(parseVersion('2.1.280 (Claude Code)')).toBe('2.1.280')
    expect(parseVersion('sem versão')).toBeNull()
    expect(isCertified('agy', '1.2.10')).toBe(true)
    expect(isCertified('agy', '1.2.11')).toBe(true)
    expect(isCertified('agy', '1.2.99')).toBe(false)
    expect(isCertified('claude', null)).toBe(false)
  })
})
