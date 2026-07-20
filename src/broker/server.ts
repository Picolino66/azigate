import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectCapabilities, type ProviderCapabilities } from './capabilities.js'
import { loadBrokerConfig, type BrokerConfig } from './config.js'
import { BrokerExecutor } from './executor.js'
import { ProcessRunner, type ProcessRunnerLike } from './process-runner.js'
import { InteractiveProcessFactory, type InteractiveProcessFactoryLike } from './interactive-process.js'
import { MemorySessionExecutor } from './memory-executor.js'
import { BROKER_PROTOCOL_VERSION, type BrokerErrorResponse } from './protocol.js'
import { isBrokerExecuteRequest } from './protocol-validation.js'
import { CliBusyError } from '../providers/errors.js'
import { ClientAbortedError, GatewayError } from '../upstream/errors.js'

class InvalidBrokerRequestError extends GatewayError {
  constructor(message = 'A requisição interna é inválida', statusCode = 400, code = 'invalid_broker_request') {
    super(statusCode, code, message)
  }
}

function sendJson(response: ServerResponse, status: number, payload: object): void {
  if (response.destroyed || response.writableEnded) return
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function errorResponse(error: unknown): { status: number; payload: BrokerErrorResponse } {
  const gatewayError = error instanceof GatewayError
    ? error
    : new GatewayError(502, 'cli_execution_failed', 'O CLI não conseguiu produzir uma decisão')
  return {
    status: gatewayError.statusCode,
    payload: {
      version: BROKER_PROTOCOL_VERSION,
      error: { code: gatewayError.code, message: gatewayError.publicMessage },
    },
  }
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let rejected = false
    request.on('data', (chunk: Buffer) => {
      if (rejected) return
      size += chunk.length
      if (size > maxBytes) {
        rejected = true
        reject(new InvalidBrokerRequestError('A requisição interna excede o limite', 413, 'broker_request_too_large'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (rejected) return
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new InvalidBrokerRequestError())
      }
    })
    request.on('error', (error) => {
      if (!rejected) reject(error)
    })
  })
}

export class BrokerController {
  private busy = false
  private active: AbortController | undefined

  constructor(
    private readonly config: BrokerConfig,
    private readonly capabilities: ProviderCapabilities,
    private readonly executor: BrokerExecutor,
  ) {}

  handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method === 'GET' && request.url === '/health') {
      const ready = this.capabilities.codex.available || this.capabilities.claude.available
      sendJson(response, 200, {
        version: BROKER_PROTOCOL_VERSION,
        status: ready ? 'ready' : 'degraded',
        providers: {
          codex: this.publicHealth('codex'),
          claude: this.publicHealth('claude'),
        },
      })
      return
    }
    if (request.method !== 'POST' || request.url !== '/execute') {
      sendJson(response, 404, errorResponse(new InvalidBrokerRequestError('Endpoint interno não encontrado', 404, 'route_not_found')).payload)
      return
    }
    if (request.headers['x-broker-protocol-version'] !== String(BROKER_PROTOCOL_VERSION)) {
      sendJson(response, 400, errorResponse(new InvalidBrokerRequestError('Versão do protocolo interno incompatível')).payload)
      return
    }
    if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      sendJson(response, 415, errorResponse(new InvalidBrokerRequestError('Content-Type interno deve ser application/json', 415, 'unsupported_media_type')).payload)
      return
    }
    if (this.busy) {
      request.resume()
      const busy = errorResponse(new CliBusyError())
      sendJson(response, busy.status, busy.payload)
      return
    }

    try {
      const payload = await readBody(request, this.config.maxRequestBytes)
      if (!isBrokerExecuteRequest(payload)) throw new InvalidBrokerRequestError()
      if (this.busy) throw new CliBusyError()
      this.busy = true
      const controller = new AbortController()
      this.active = controller
      let finished = false
      const abort = (): void => {
        if (!finished) controller.abort(new ClientAbortedError())
      }
      request.once('aborted', abort)
      response.once('close', abort)
      try {
        const result = await this.executor.execute(payload, controller.signal)
        finished = true
        sendJson(response, 200, result)
      } finally {
        finished = true
        request.removeListener('aborted', abort)
        response.removeListener('close', abort)
        this.active = undefined
        this.busy = false
      }
    } catch (error) {
      if (error instanceof ClientAbortedError) return
      const result = errorResponse(error)
      sendJson(response, result.status, result.payload)
    }
  }

  async shutdown(): Promise<void> {
    this.active?.abort(new ClientAbortedError())
    await this.executor.shutdown()
  }

  private publicHealth(provider: 'codex' | 'claude'): { available: boolean; code?: string } {
    const capability = this.capabilities[provider]
    return {
      available: capability.available,
      ...(capability.code === undefined ? {} : { code: capability.code }),
    }
  }
}

export function createBrokerServer(
  config: BrokerConfig,
  capabilities: ProviderCapabilities,
  runner: ProcessRunnerLike,
  interactiveFactory: InteractiveProcessFactoryLike = new InteractiveProcessFactory(),
): { server: Server; controller: BrokerController } {
  const memoryExecutor = new MemorySessionExecutor(config, capabilities, interactiveFactory)
  const executor = new BrokerExecutor(config, runner, capabilities, memoryExecutor)
  const controller = new BrokerController(config, capabilities, executor)
  const server = createServer((request, response) => {
    void controller.handler(request, response)
  })
  return { server, controller }
}

export async function listenBroker(
  config: BrokerConfig,
  server: Server,
): Promise<void> {
  const directory = dirname(config.socketPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  try {
    const current = await lstat(config.socketPath)
    if (!current.isSocket()) throw new Error('BROKER_SOCKET_PATH existe e não é um Unix socket')
    await unlink(config.socketPath)
  } catch (error) {
    if (!error || typeof error !== 'object' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.socketPath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  await chmod(config.socketPath, 0o600)
}

async function main(): Promise<void> {
  const config = loadBrokerConfig()
  const runner = new ProcessRunner()
  const capabilities = await inspectCapabilities(config, runner)
  const { server, controller } = createBrokerServer(config, capabilities, runner)
  await listenBroker(config, server)
  process.stdout.write(`${JSON.stringify({
    level: 'info',
    event: 'broker_started',
    providers: {
      codex: capabilities.codex.available,
      claude: capabilities.claude.available,
    },
  })}\n`)
  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()))
    void Promise.all([controller.shutdown(), serverClosed]).then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      level: 'error',
      event: 'broker_start_failed',
      error: error instanceof Error ? error.name : 'UnknownError',
    })}\n`)
    process.exit(1)
  })
}
