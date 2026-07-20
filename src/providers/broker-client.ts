import { request as httpRequest } from 'node:http'
import type {
  BrokerExecuteRequest,
  BrokerExecuteResponse,
  BrokerHealthResponse,
  BrokerUsage,
} from '../broker/protocol.js'
import { BROKER_PROTOCOL_VERSION } from '../broker/protocol.js'
import { ClientAbortedError, GatewayError } from '../upstream/errors.js'
import {
  CliBusyError,
  CliContextTooLargeError,
  CliExecutionFailedError,
  CliTimeoutError,
  CliUnavailableError,
  InvalidCliOutputError,
} from './errors.js'

const MAX_PROTOCOL_RESPONSE_BYTES = 5 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isUsage(value: unknown): value is BrokerUsage {
  if (!isRecord(value)) return false
  const allowed = [
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'freshInputTokens',
    'cachedInputTokens',
    'cacheCreationInputTokens',
    'cacheReadInputTokens',
    'reasoningOutputTokens',
    'estimatedCostUsd',
  ]
  return Object.keys(value).every((key) => allowed.includes(key)) && allowed.every((key) =>
    value[key] === undefined || (
      typeof value[key] === 'number' &&
      Number.isFinite(value[key]) &&
      value[key] >= 0 &&
      (key === 'estimatedCostUsd' || Number.isSafeInteger(value[key]))
    ))
}

function isHealth(value: unknown): value is BrokerHealthResponse {
  if (!isRecord(value) || value.version !== BROKER_PROTOCOL_VERSION || !isRecord(value.providers)) return false
  const providers = value.providers
  return ['codex', 'claude'].every((provider) => {
    const health = providers[provider]
    return isRecord(health) && typeof health.available === 'boolean'
  })
}

function isExecuteResponse(value: unknown): value is BrokerExecuteResponse {
  const execution = isRecord(value) && isRecord(value.execution) ? value.execution : undefined
  if (
    !isRecord(value) ||
    value.version !== BROKER_PROTOCOL_VERSION ||
    typeof value.requestId !== 'string' ||
    !isRecord(value.decision) ||
    (value.decision.content !== null && typeof value.decision.content !== 'string') ||
    !Array.isArray(value.decision.toolCalls) ||
    execution === undefined ||
    !['stateless', 'memory'].includes(String(execution.sessionMode)) ||
    typeof execution.sessionReused !== 'boolean' ||
    !Number.isSafeInteger(execution.transcriptBytes) ||
    typeof execution.transcriptBytes !== 'number' ||
    execution.transcriptBytes < 0
  ) {
    return false
  }
  return (value.usage === undefined || isUsage(value.usage)) && value.decision.toolCalls.every((call) =>
    isRecord(call) && typeof call.name === 'string' && typeof call.arguments === 'string')
}

function brokerError(status: number, payload: unknown): GatewayError {
  const code = isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === 'string'
    ? payload.error.code
    : ''
  if (status === 429 || code === 'cli_busy') return new CliBusyError()
  if (status === 504 || code === 'cli_timeout') return new CliTimeoutError()
  if (status === 503 || code === 'cli_unavailable') return new CliUnavailableError()
  if (status === 413 || code === 'cli_context_too_large') return new CliContextTooLargeError()
  if (code === 'invalid_cli_output') return new InvalidCliOutputError()
  return new CliExecutionFailedError()
}

export interface CliBrokerClientLike {
  health(signal?: AbortSignal): Promise<BrokerHealthResponse>
  execute(input: BrokerExecuteRequest, signal?: AbortSignal): Promise<BrokerExecuteResponse>
}

export class CliBrokerClient implements CliBrokerClientLike {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs: number,
  ) {}

  async health(signal?: AbortSignal): Promise<BrokerHealthResponse> {
    const result = await this.requestJson('GET', '/health', undefined, signal)
    if (result.status !== 200 || !isHealth(result.payload)) throw new CliUnavailableError()
    return result.payload
  }

  async execute(input: BrokerExecuteRequest, signal?: AbortSignal): Promise<BrokerExecuteResponse> {
    const result = await this.requestJson('POST', '/execute', JSON.stringify(input), signal)
    if (result.status !== 200) throw brokerError(result.status, result.payload)
    if (!isExecuteResponse(result.payload) || result.payload.requestId !== input.requestId) {
      throw new InvalidCliOutputError()
    }
    return result.payload
  }

  private requestJson(
    method: 'GET' | 'POST',
    path: string,
    body?: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; payload: unknown }> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        action()
      }
      const request = httpRequest(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: {
            accept: 'application/json',
            'x-broker-protocol-version': String(BROKER_PROTOCOL_VERSION),
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_PROTOCOL_RESPONSE_BYTES) {
              request.destroy(new InvalidCliOutputError())
              return
            }
            chunks.push(chunk)
          })
          response.on('end', () => {
            let payload: unknown
            try {
              payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {
              finish(() => reject(new InvalidCliOutputError()))
              return
            }
            finish(() => resolve({ status: response.statusCode ?? 502, payload }))
          })
        },
      )
      const onAbort = (): void => {
        request.destroy(new ClientAbortedError())
      }
      const timer = setTimeout(() => request.destroy(new CliTimeoutError()), this.timeoutMs)
      timer.unref()
      request.once('error', (error) => {
        if (error instanceof GatewayError) {
          finish(() => reject(error))
          return
        }
        finish(() => reject(new CliUnavailableError()))
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }
      if (body !== undefined) request.write(body)
      request.end()
    })
  }
}
