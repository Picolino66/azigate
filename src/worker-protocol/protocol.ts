import { isRecord } from '../agents/core/agent-event.js'

export const WORKER_PROTOCOL_VERSION = 1
export const WORKER_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024

export const WORKER_METHODS = [
  'list_directory',
  'find_file',
  'search',
  'read_file',
  'write_file',
  'edit_file',
  'mkdir',
  'delete',
  'git_status',
  'git_diff',
  'git_log',
  'shell_exec',
  'process_start',
  'process_stdin',
  'process_output',
  'process_kill',
] as const
export type WorkerMethod = (typeof WORKER_METHODS)[number]

export const READ_ONLY_METHODS: ReadonlySet<WorkerMethod> = new Set([
  'list_directory',
  'find_file',
  'search',
  'read_file',
  'git_status',
  'git_diff',
  'git_log',
])
export const EXEC_METHODS: ReadonlySet<WorkerMethod> = new Set([
  'shell_exec',
  'process_start',
  'process_stdin',
  'process_output',
  'process_kill',
])

export const WORKER_CAPABILITIES = ['filesystem', 'git', 'exec'] as const
export type WorkerCapability = (typeof WORKER_CAPABILITIES)[number]

export const WORKER_ERROR_CODES = [
  'invalid_params',
  'method_not_found',
  'workspace_not_found',
  'path_outside_workspace',
  'not_found',
  'already_exists',
  'too_large',
  'conflict',
  'exec_disabled',
  'command_not_allowed',
  'process_not_found',
  'process_limit',
  'timeout',
  'io_error',
  'worker_unavailable',
  'permission_denied',
] as const
export type WorkerErrorCode = (typeof WORKER_ERROR_CODES)[number]

export class WorkerRpcError extends Error {
  override readonly name = 'WorkerRpcError'
  constructor(
    readonly code: WorkerErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export function isWorkerMethod(value: unknown): value is WorkerMethod {
  return typeof value === 'string' && (WORKER_METHODS as readonly string[]).includes(value)
}

function isErrorCode(value: unknown): value is WorkerErrorCode {
  return typeof value === 'string' && (WORKER_ERROR_CODES as readonly string[]).includes(value)
}

export interface RegisterMessage {
  type: 'worker.register'
  protocolVersion: number
  workerId: string
  workerVersion: string
  capabilities: WorkerCapability[]
  workspaces: string[]
}

export interface RpcRequestMessage {
  type: 'rpc.request'
  id: string
  workspace: string
  method: WorkerMethod
  params: Record<string, unknown>
}

export type RpcResponseMessage =
  | { type: 'rpc.response'; id: string; ok: true; result: unknown }
  | { type: 'rpc.response'; id: string; ok: false; error: { code: WorkerErrorCode; message: string } }

export type WorkerToGateway = RegisterMessage | { type: 'worker.heartbeat' } | RpcResponseMessage

export type GatewayToWorker =
  | { type: 'worker.registered'; workerId: string; workspaces: string[]; heartbeatIntervalMs: number }
  | { type: 'worker.rejected'; code: string; message: string }
  | RpcRequestMessage

function parse(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function stringArray(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined
  return value.every((item) => typeof item === 'string' && item.length <= 128) ? (value as string[]) : undefined
}

export function parseWorkerMessage(raw: string): WorkerToGateway | undefined {
  const message = parse(raw)
  if (!message) return undefined
  if (message.type === 'worker.heartbeat') return { type: 'worker.heartbeat' }
  if (message.type === 'worker.register') {
    const workspaces = stringArray(message.workspaces, 256)
    const capabilities = stringArray(message.capabilities, 8)
    if (
      typeof message.protocolVersion !== 'number' ||
      typeof message.workerId !== 'string' ||
      typeof message.workerVersion !== 'string' ||
      !workspaces ||
      !capabilities
    ) {
      return undefined
    }
    return {
      type: 'worker.register',
      protocolVersion: message.protocolVersion,
      workerId: message.workerId,
      workerVersion: message.workerVersion.slice(0, 64),
      capabilities: capabilities.filter((item): item is WorkerCapability =>
        (WORKER_CAPABILITIES as readonly string[]).includes(item),
      ),
      workspaces,
    }
  }
  if (message.type === 'rpc.response' && typeof message.id === 'string') {
    if (message.ok === true) return { type: 'rpc.response', id: message.id, ok: true, result: message.result }
    if (message.ok === false && isRecord(message.error) && isErrorCode(message.error.code)) {
      const text = typeof message.error.message === 'string' ? message.error.message.slice(0, 500) : 'Erro no worker'
      return { type: 'rpc.response', id: message.id, ok: false, error: { code: message.error.code, message: text } }
    }
  }
  return undefined
}

export function parseGatewayMessage(raw: string): GatewayToWorker | undefined {
  const message = parse(raw)
  if (!message) return undefined
  if (message.type === 'worker.registered') {
    const workspaces = stringArray(message.workspaces, 256)
    if (typeof message.workerId !== 'string' || !workspaces || typeof message.heartbeatIntervalMs !== 'number') {
      return undefined
    }
    return {
      type: 'worker.registered',
      workerId: message.workerId,
      workspaces,
      heartbeatIntervalMs: message.heartbeatIntervalMs,
    }
  }
  if (message.type === 'worker.rejected') {
    return {
      type: 'worker.rejected',
      code: typeof message.code === 'string' ? message.code : 'rejected',
      message: typeof message.message === 'string' ? message.message : '',
    }
  }
  if (
    message.type === 'rpc.request' &&
    typeof message.id === 'string' &&
    typeof message.workspace === 'string' &&
    typeof message.method === 'string' &&
    isRecord(message.params)
  ) {
    if (!isWorkerMethod(message.method)) {
      return undefined
    }
    return {
      type: 'rpc.request',
      id: message.id,
      workspace: message.workspace,
      method: message.method,
      params: message.params,
    }
  }
  return undefined
}

type JsonSchema = Record<string, unknown>

const path = (description: string): JsonSchema => ({ type: 'string', description })
const argv: JsonSchema = {
  type: 'array',
  items: { type: 'string' },
  minItems: 1,
  description: 'Programa e argumentos, sem shell. Ex.: ["npm", "test"].',
}

/** Esquemas dos parâmetros de cada método, publicados também como ferramentas MCP. */
export const WORKER_METHOD_SCHEMAS: Readonly<Record<WorkerMethod, { description: string; inputSchema: JsonSchema }>> = {
  list_directory: {
    description: 'Lista um diretório do workspace remoto.',
    inputSchema: { type: 'object', properties: { path: path('Diretório relativo à raiz; padrão ".".') } },
  },
  find_file: {
    description: 'Procura arquivos pelo nome (glob com * e ?) no workspace remoto.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: path('Diretório inicial relativo.'),
        maxResults: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: ['pattern'],
    },
  },
  search: {
    description: 'Busca texto literal (não regex) nos arquivos do workspace remoto.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: path('Diretório inicial relativo.'),
        maxResults: { type: 'integer', minimum: 1, maximum: 500 },
        caseSensitive: { type: 'boolean' },
      },
      required: ['query'],
    },
  },
  read_file: {
    description: 'Lê um arquivo do workspace remoto (até 1 MiB).',
    inputSchema: {
      type: 'object',
      properties: {
        path: path('Arquivo relativo à raiz.'),
        offset: { type: 'integer', minimum: 1, description: 'Linha inicial (base 1).' },
        limit: { type: 'integer', minimum: 1, description: 'Quantidade de linhas.' },
      },
      required: ['path'],
    },
  },
  write_file: {
    description: 'Cria ou substitui um arquivo do workspace remoto.',
    inputSchema: {
      type: 'object',
      properties: { path: path('Arquivo relativo.'), content: { type: 'string' }, createDirectories: { type: 'boolean' } },
      required: ['path', 'content'],
    },
  },
  edit_file: {
    description: 'Substitui um trecho exato de um arquivo do workspace remoto.',
    inputSchema: {
      type: 'object',
      properties: {
        path: path('Arquivo relativo.'),
        oldText: { type: 'string' },
        newText: { type: 'string' },
        replaceAll: { type: 'boolean' },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },
  mkdir: {
    description: 'Cria um diretório (recursivo) no workspace remoto.',
    inputSchema: { type: 'object', properties: { path: path('Diretório relativo.') }, required: ['path'] },
  },
  delete: {
    description: 'Remove um arquivo ou diretório do workspace remoto.',
    inputSchema: {
      type: 'object',
      properties: { path: path('Alvo relativo.'), recursive: { type: 'boolean' } },
      required: ['path'],
    },
  },
  git_status: {
    description: 'git status --porcelain=v1 --branch no workspace remoto.',
    inputSchema: { type: 'object', properties: {} },
  },
  git_diff: {
    description: 'git diff (ou --cached) no workspace remoto.',
    inputSchema: { type: 'object', properties: { staged: { type: 'boolean' }, path: path('Limita a um path relativo.') } },
  },
  git_log: {
    description: 'Últimos commits do workspace remoto.',
    inputSchema: { type: 'object', properties: { maxCount: { type: 'integer', minimum: 1, maximum: 200 } } },
  },
  shell_exec: {
    description: 'Executa um programa por argv (sem shell) no workspace remoto e devolve a saída.',
    inputSchema: {
      type: 'object',
      properties: {
        argv,
        cwd: path('Diretório relativo; padrão ".".'),
        timeoutMs: { type: 'integer', minimum: 1, maximum: 600_000 },
        stdin: { type: 'string' },
      },
      required: ['argv'],
    },
  },
  process_start: {
    description: 'Inicia um processo de longa duração por argv no workspace remoto.',
    inputSchema: { type: 'object', properties: { argv, cwd: path('Diretório relativo.') }, required: ['argv'] },
  },
  process_stdin: {
    description: 'Escreve no stdin de um processo iniciado com process_start.',
    inputSchema: {
      type: 'object',
      properties: { processId: { type: 'string' }, data: { type: 'string' }, close: { type: 'boolean' } },
      required: ['processId'],
    },
  },
  process_output: {
    description: 'Lê a saída acumulada de um processo a partir de um cursor.',
    inputSchema: {
      type: 'object',
      properties: { processId: { type: 'string' }, cursor: { type: 'integer', minimum: 0 } },
      required: ['processId'],
    },
  },
  process_kill: {
    description: 'Encerra um processo iniciado com process_start.',
    inputSchema: {
      type: 'object',
      properties: { processId: { type: 'string' }, signal: { enum: ['SIGTERM', 'SIGKILL', 'SIGINT'] } },
      required: ['processId'],
    },
  },
}
