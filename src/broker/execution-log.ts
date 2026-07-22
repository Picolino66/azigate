import { appendFile, chmod, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrokerConfig } from './config.js'
import type { BrokerExecuteRequest } from './protocol.js'

export const EXECUTION_LOG_PHASES = [
  'received',
  'provider_dispatch_started',
  'workspace_prepared',
  'provider_turn_started',
  'provider_turn_finished',
  'decision_validated',
  'completed',
  'failed',
] as const

export type ExecutionLogPhase = typeof EXECUTION_LOG_PHASES[number]

export type ExecutionFailureReason =
  | 'unknown'
  | 'decision_shape_invalid'
  | 'decision_json_invalid'
  | 'decision_tool_not_offered'
  | 'decision_arguments_invalid'
  | 'decision_content_tool_calls_conflict'
  | 'decision_tool_choice_conflict'
  | 'decision_parallel_calls_conflict'
  | 'unexpected_local_tool_event'
  | 'codex_decision_missing'
  | 'codex_event_protocol_invalid'
  | 'claude_result_error_during_execution'
  | 'claude_result_error_max_structured_output_retries'
  | 'claude_result_error_max_turns'
  | 'claude_result_error_max_budget_usd'
  | 'claude_result_error_unknown'
  | 'cli_process_closed'
  | 'cli_output_limit'
  | 'cli_timeout'
  | 'cli_context_too_large'
  | 'cli_execution_failed'

export interface ExecutionProgress {
  phase: Exclude<ExecutionLogPhase, 'received' | 'completed' | 'failed'>
}

export interface ExecutionProgressReporter {
  report(progress: ExecutionProgress): Promise<void>
}

interface ExecutionLogEvent {
  timestamp: string
  requestId: string
  provider: BrokerExecuteRequest['provider']
  model: BrokerExecuteRequest['model']
  effort?: BrokerExecuteRequest['effort']
  sessionMode: 'memory' | 'stateless'
  transcriptBytes: number
  phase: ExecutionLogPhase
  durationMs?: number
  sessionReused?: boolean
  reason?: ExecutionFailureReason
}

function isReason(value: unknown): value is ExecutionFailureReason {
  return [
    'unknown',
    'decision_shape_invalid',
    'decision_json_invalid',
    'decision_tool_not_offered',
    'decision_arguments_invalid',
    'decision_content_tool_calls_conflict',
    'decision_tool_choice_conflict',
    'decision_parallel_calls_conflict',
    'unexpected_local_tool_event',
    'codex_decision_missing',
    'codex_event_protocol_invalid',
    'claude_result_error_during_execution',
    'claude_result_error_max_structured_output_retries',
    'claude_result_error_max_turns',
    'claude_result_error_max_budget_usd',
    'claude_result_error_unknown',
    'cli_process_closed',
    'cli_output_limit',
    'cli_timeout',
    'cli_context_too_large',
    'cli_execution_failed',
  ].includes(value as ExecutionFailureReason)
}

export function executionFailureReason(error: unknown): ExecutionFailureReason {
  if (error !== null && typeof error === 'object' && isReason((error as { executionReason?: unknown }).executionReason)) {
    return (error as { executionReason: ExecutionFailureReason }).executionReason
  }
  return 'unknown'
}

export class ExecutionLogWriter implements ExecutionProgressReporter {
  private initialized = false
  private readonly filePath: string
  private readonly startedAt = Date.now()

  constructor(
    private readonly config: Pick<BrokerConfig, 'executionLogDir' | 'executionLogMaxBytes' | 'executionLogMaxFiles'>,
    private readonly request: BrokerExecuteRequest,
    private readonly sessionMode: 'memory' | 'stateless',
    private readonly transcriptBytes: number,
  ) {
    this.filePath = join(config.executionLogDir, 'executions.jsonl')
  }

  async start(): Promise<void> {
    await this.write('received')
  }

  async report(progress: ExecutionProgress): Promise<void> {
    await this.write(progress.phase)
  }

  async complete(sessionReused: boolean): Promise<void> {
    await this.write('completed', { sessionReused })
  }

  async fail(error: unknown): Promise<void> {
    await this.write('failed', { reason: executionFailureReason(error) })
  }

  private async write(
    phase: ExecutionLogPhase,
    extra: Pick<ExecutionLogEvent, 'reason' | 'sessionReused'> = {},
  ): Promise<void> {
    try {
      await this.ensureReady()
      const event: ExecutionLogEvent = {
        timestamp: new Date().toISOString(),
        requestId: this.request.requestId,
        provider: this.request.provider,
        model: this.request.model,
        ...(this.request.effort === undefined ? {} : { effort: this.request.effort }),
        sessionMode: this.sessionMode,
        transcriptBytes: this.transcriptBytes,
        phase,
        ...(phase === 'received' ? {} : { durationMs: Date.now() - this.startedAt }),
        ...extra,
      }
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
      await chmod(this.filePath, 0o600)
    } catch {
      // A indisponibilidade da telemetria não pode expor dados nem interromper o broker.
    }
  }

  private async ensureReady(): Promise<void> {
    if (!this.initialized) {
      await mkdir(this.config.executionLogDir, { recursive: true, mode: 0o700 })
      await chmod(this.config.executionLogDir, 0o700)
      this.initialized = true
    }
    try {
      const current = await stat(this.filePath)
      if (current.size >= this.config.executionLogMaxBytes) await this.rotate()
    } catch (error) {
      if (!error || typeof error !== 'object' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async rotate(): Promise<void> {
    for (let index = this.config.executionLogMaxFiles - 1; index >= 1; index -= 1) {
      const from = join(this.config.executionLogDir, `executions.${index}.jsonl`)
      const to = join(this.config.executionLogDir, `executions.${index + 1}.jsonl`)
      try {
        if (index === this.config.executionLogMaxFiles - 1) await unlink(from)
        else await rename(from, to)
      } catch (error) {
        if (!error || typeof error !== 'object' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    await rename(this.filePath, join(this.config.executionLogDir, 'executions.1.jsonl'))
  }
}
