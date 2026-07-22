import { GatewayError } from '../upstream/errors.js'

export class CliBusyError extends GatewayError {
  constructor() {
    super(429, 'cli_busy', 'O broker CLI já está executando outra solicitação')
  }
}

export class InvalidCliOutputError extends GatewayError {
  readonly executionReason: string

  constructor(executionReason = 'decision_shape_invalid') {
    super(502, 'invalid_cli_output', 'O CLI retornou uma decisão inválida')
    this.executionReason = executionReason
  }
}

export class CliExecutionFailedError extends GatewayError {
  readonly executionReason: string

  constructor(executionReason = 'cli_execution_failed') {
    super(502, 'cli_execution_failed', 'O CLI não conseguiu produzir uma decisão')
    this.executionReason = executionReason
  }
}

export class CliUnavailableError extends GatewayError {
  constructor() {
    super(503, 'cli_unavailable', 'O provedor CLI solicitado não está disponível')
  }
}

export class ProvidersUnavailableError extends GatewayError {
  constructor() {
    super(503, 'providers_unavailable', 'Nenhum provedor está disponível')
  }
}

export class CliTimeoutError extends GatewayError {
  readonly executionReason = 'cli_timeout'

  constructor() {
    super(504, 'cli_timeout', 'O CLI não respondeu dentro do tempo limite')
  }
}

export class CliContextTooLargeError extends GatewayError {
  readonly executionReason = 'cli_context_too_large'

  constructor() {
    super(413, 'cli_context_too_large', 'O contexto para o provedor CLI excede o limite configurado')
  }
}
