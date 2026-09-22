import { GatewayError } from '../upstream/errors.js'

export class ProviderTimeoutError extends GatewayError {
  constructor(provider: string) {
    super(504, `${provider}_timeout`, `O provedor ${provider} não respondeu dentro do tempo limite`)
  }
}

export class ProviderConnectionError extends GatewayError {
  constructor(provider: string) {
    super(502, `${provider}_connection_error`, `Não foi possível conectar ao provedor ${provider}`)
  }
}

export class ProviderProtocolError extends GatewayError {
  constructor(provider: string) {
    super(502, `${provider}_protocol_error`, `O provedor ${provider} retornou uma resposta inválida`)
  }
}

export class ProviderUpstreamError extends GatewayError {
  constructor(provider: string, status: number, retryAfterSeconds?: string) {
    const safeStatus = status >= 400 && status < 600 ? status : 502
    super(
      safeStatus,
      `${provider}_upstream_error`,
      `O provedor ${provider} retornou um erro`,
      retryAfterSeconds,
    )
  }
}
