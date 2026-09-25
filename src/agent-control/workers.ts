import { newId } from '../agents/core/ids.js'
import {
  EXEC_METHODS,
  WORKER_PROTOCOL_VERSION,
  WorkerRpcError,
  parseWorkerMessage,
  type WorkerCapability,
  type WorkerMethod,
} from '../worker-protocol/protocol.js'
import type { WorkerIdentity } from '../worker-protocol/security.js'
import { CLOSE_CODES, frameToText, sendJson, type WorkerSocket } from '../worker-protocol/transport.js'

interface PendingCall {
  resolve(result: unknown): void
  reject(error: WorkerRpcError): void
  timer: NodeJS.Timeout
}

interface ConnectedWorker {
  id: string
  socket: WorkerSocket
  workspaces: Set<string>
  capabilities: Set<WorkerCapability>
  workerVersion: string
  connectedAt: number
  lastHeartbeatAt: number
  pending: Map<string, PendingCall>
}

export interface WorkerView {
  id: string
  connectedAt: string
  lastHeartbeatAt: string
  workerVersion: string
  capabilities: WorkerCapability[]
  workspaces: string[]
}

export interface WorkerHubOptions {
  heartbeatIntervalMs: number
  registrationTimeoutMs: number
  diagnostic?: (event: string, fields?: Record<string, string | number | boolean>) => void
  now?: () => number
}

/**
 * Workers conectados ao agentd (ADR-023). O worker autentica antes do upgrade; aqui o
 * primeiro frame precisa ser o registro, com o mesmo `workerId` do token e somente
 * workspaces dentro dos escopos. O estado é local ao processo.
 */
export class WorkerHub {
  private readonly workers = new Map<string, ConnectedWorker>()
  private readonly sweeper: NodeJS.Timeout
  private readonly now: () => number

  constructor(private readonly options: WorkerHubOptions) {
    this.now = options.now ?? Date.now
    this.sweeper = setInterval(() => this.sweep(), options.heartbeatIntervalMs)
    this.sweeper.unref()
  }

  attach(socket: WorkerSocket, identity: WorkerIdentity): void {
    let worker: ConnectedWorker | undefined
    const registrationTimer = setTimeout(() => {
      if (!worker) socket.close(CLOSE_CODES.rejected, 'registro ausente')
    }, this.options.registrationTimeoutMs)
    registrationTimer.unref()
    // O token vale só até a expiração, mesmo em conexões longas.
    const expiryTimer = setTimeout(
      () => socket.close(CLOSE_CODES.unauthorized, 'token expirado'),
      Math.max(identity.expiresAt - this.now(), 0),
    )
    expiryTimer.unref()

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(CLOSE_CODES.unsupportedData, 'frame binário')
        return
      }
      const message = parseWorkerMessage(frameToText(data))
      if (!message) {
        socket.close(CLOSE_CODES.unsupportedData, 'mensagem inválida')
        return
      }
      if (!worker) {
        if (message.type !== 'worker.register') {
          socket.close(CLOSE_CODES.rejected, 'registro esperado')
          return
        }
        clearTimeout(registrationTimer)
        worker = this.register(socket, identity, message)
        return
      }
      if (message.type === 'worker.heartbeat') {
        worker.lastHeartbeatAt = this.now()
        return
      }
      if (message.type === 'rpc.response') {
        const pending = worker.pending.get(message.id)
        if (!pending) return
        worker.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.ok) pending.resolve(message.result)
        else pending.reject(new WorkerRpcError(message.error.code, message.error.message))
        return
      }
      socket.close(CLOSE_CODES.unsupportedData, 'mensagem inesperada')
    })
    socket.on('close', () => {
      clearTimeout(registrationTimer)
      clearTimeout(expiryTimer)
      if (worker && this.workers.get(worker.id) === worker) {
        this.workers.delete(worker.id)
        this.options.diagnostic?.('worker_disconnected', { workerId: worker.id })
      }
      if (worker) this.failPending(worker)
    })
    socket.on('error', () => undefined)
  }

  list(): WorkerView[] {
    return [...this.workers.values()].map((worker) => ({
      id: worker.id,
      connectedAt: new Date(worker.connectedAt).toISOString(),
      lastHeartbeatAt: new Date(worker.lastHeartbeatAt).toISOString(),
      workerVersion: worker.workerVersion,
      capabilities: [...worker.capabilities],
      workspaces: [...worker.workspaces],
    }))
  }

  isConnected(workerId: string): boolean {
    return this.workers.has(workerId)
  }

  hasWorkspace(workerId: string, workspace: string): boolean {
    return this.workers.get(workerId)?.workspaces.has(workspace) ?? false
  }

  call(
    workerId: string,
    workspace: string,
    method: WorkerMethod,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const worker = this.workers.get(workerId)
    if (!worker) return Promise.reject(new WorkerRpcError('worker_unavailable', 'Worker não conectado'))
    if (!worker.workspaces.has(workspace)) {
      return Promise.reject(new WorkerRpcError('workspace_not_found', 'Workspace não disponível no worker'))
    }
    if (EXEC_METHODS.has(method) && !worker.capabilities.has('exec')) {
      return Promise.reject(new WorkerRpcError('exec_disabled', 'Execução desabilitada no worker'))
    }
    const id = newId('rpc')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.pending.delete(id)
        reject(new WorkerRpcError('timeout', 'Tempo esgotado aguardando o worker'))
      }, timeoutMs)
      timer.unref()
      worker.pending.set(id, { resolve, reject, timer })
      if (!sendJson(worker.socket, { type: 'rpc.request', id, workspace, method, params })) {
        clearTimeout(timer)
        worker.pending.delete(id)
        reject(new WorkerRpcError('worker_unavailable', 'Worker não conectado'))
      }
    })
  }

  closeAll(): void {
    clearInterval(this.sweeper)
    for (const worker of this.workers.values()) {
      this.failPending(worker)
      worker.socket.close(CLOSE_CODES.normal, 'agentd encerrando')
    }
    this.workers.clear()
  }

  private register(
    socket: WorkerSocket,
    identity: WorkerIdentity,
    message: Extract<ReturnType<typeof parseWorkerMessage>, { type: 'worker.register' }>,
  ): ConnectedWorker | undefined {
    const reject = (code: string, text: string): undefined => {
      sendJson(socket, { type: 'worker.rejected', code, message: text })
      socket.close(CLOSE_CODES.rejected, code)
      this.options.diagnostic?.('worker_rejected', { code })
      return undefined
    }
    if (message.protocolVersion !== WORKER_PROTOCOL_VERSION) return reject('protocol_version', 'Versão de protocolo não suportada')
    if (message.workerId !== identity.workerId) return reject('worker_id_mismatch', 'O workerId não corresponde ao token')
    const workspaces = new Set(message.workspaces.filter((workspace) => identity.workspaces.has(workspace)))
    if (workspaces.size === 0) return reject('no_authorized_workspace', 'Nenhum workspace autorizado pelo token')

    const previous = this.workers.get(identity.workerId)
    if (previous) {
      this.workers.delete(identity.workerId)
      this.failPending(previous)
      previous.socket.close(CLOSE_CODES.replaced, 'substituído por nova conexão')
    }
    const now = this.now()
    const worker: ConnectedWorker = {
      id: identity.workerId,
      socket,
      workspaces,
      capabilities: new Set(message.capabilities),
      workerVersion: message.workerVersion,
      connectedAt: now,
      lastHeartbeatAt: now,
      pending: new Map(),
    }
    this.workers.set(worker.id, worker)
    sendJson(socket, {
      type: 'worker.registered',
      workerId: worker.id,
      workspaces: [...workspaces],
      heartbeatIntervalMs: this.options.heartbeatIntervalMs,
    })
    this.options.diagnostic?.('worker_registered', { workerId: worker.id, workspaces: workspaces.size })
    return worker
  }

  private sweep(): void {
    const limit = this.now() - this.options.heartbeatIntervalMs * 3
    for (const worker of [...this.workers.values()]) {
      if (worker.lastHeartbeatAt >= limit) continue
      this.workers.delete(worker.id)
      this.failPending(worker)
      worker.socket.close(CLOSE_CODES.heartbeatTimeout, 'heartbeat ausente')
      this.options.diagnostic?.('worker_heartbeat_timeout', { workerId: worker.id })
    }
  }

  private failPending(worker: ConnectedWorker): void {
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new WorkerRpcError('worker_unavailable', 'Worker desconectado'))
    }
    worker.pending.clear()
  }
}
