import { GatewayError } from '../upstream/errors.js'

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

export class OAuthNotLoggedInError extends GatewayError {
  constructor(provider: string) {
    super(503, 'oauth_not_logged_in', `Nenhuma credencial OAuth encontrada para ${provider}. Execute o login antes de usar este provedor.`)
  }
}

export class OAuthTokenExchangeError extends GatewayError {
  constructor(provider: string) {
    super(502, 'oauth_token_exchange_failed', `Falha ao trocar o código de autorização por tokens para ${provider}`)
  }
}

export class OAuthRefreshFailedError extends GatewayError {
  constructor(provider: string) {
    super(502, 'oauth_refresh_failed', `Falha ao renovar o token OAuth de ${provider}`)
  }
}
