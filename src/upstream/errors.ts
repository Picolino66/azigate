export class GatewayError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    public readonly publicMessage: string,
    // Segundos já normalizados para o cabeçalho `retry-after`. Nunca o valor bruto do
    // fornecedor: só dígitos, sem chance de injeção de cabeçalho.
    public readonly retryAfterSeconds?: string,
  ) {
    super(publicMessage)
    this.name = new.target.name
  }
}

export class UpstreamTimeoutError extends GatewayError {
  constructor() {
    super(504, 'upstream_timeout', 'A DeepSeek não respondeu dentro do tempo limite')
  }
}

export class UpstreamConnectionError extends GatewayError {
  constructor() {
    super(502, 'upstream_connection_error', 'Não foi possível conectar à DeepSeek')
  }
}

export class UpstreamProtocolError extends GatewayError {
  constructor() {
    super(502, 'upstream_protocol_error', 'A DeepSeek retornou uma resposta inválida')
  }
}

export class ClientAbortedError extends GatewayError {
  constructor() {
    super(499, 'client_aborted', 'O cliente cancelou a requisição')
  }
}
