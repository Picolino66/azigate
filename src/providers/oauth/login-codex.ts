import { pathToFileURL } from 'node:url'
import { CODEX_OAUTH_DEFAULTS, buildCodexAuthorizationUrl, exchangeCodexCode } from './codex-oauth.js'
import { runInteractiveOAuthLogin } from './login-flow.js'
import { generateOAuthState, generatePkceCodes } from './pkce.js'
import type { StoredOAuthToken } from './token-store.js'

export async function loginCodex(tokenFilePath: string): Promise<StoredOAuthToken> {
  const pkce = generatePkceCodes()
  const state = generateOAuthState()
  const redirect = new URL(CODEX_OAUTH_DEFAULTS.redirectUri)
  return runInteractiveOAuthLogin({
    providerLabel: 'Codex (OpenAI)',
    redirectPort: Number(redirect.port),
    redirectPath: redirect.pathname,
    authorizationUrl: buildCodexAuthorizationUrl(pkce, state),
    expectedState: state,
    exchangeCode: (code) => exchangeCodexCode(code, pkce),
    tokenFilePath,
  })
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  const tokenFilePath = process.argv[2]
  if (!tokenFilePath) {
    process.stderr.write('Uso: tsx src/providers/oauth/login-codex.ts <caminho-do-arquivo-de-token>\n')
    process.exit(2)
  }
  loginCodex(tokenFilePath)
    .then((token) => {
      process.stdout.write(`Login Codex concluído para ${token.email ?? token.accountId ?? 'conta autenticada'}.\n`)
    })
    .catch((error: unknown) => {
      process.stderr.write(`Falha no login Codex: ${error instanceof Error ? error.message : 'erro desconhecido'}\n`)
      process.exit(1)
    })
}
