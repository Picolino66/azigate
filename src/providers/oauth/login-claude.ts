import { pathToFileURL } from 'node:url'
import { CLAUDE_OAUTH_DEFAULTS, buildClaudeAuthorizationUrl, exchangeClaudeCode } from './claude-oauth.js'
import { runInteractiveOAuthLogin } from './login-flow.js'
import { generateOAuthState, generatePkceCodes } from './pkce.js'
import type { StoredOAuthToken } from './token-store.js'

export async function loginClaude(tokenFilePath: string): Promise<StoredOAuthToken> {
  const pkce = generatePkceCodes()
  const state = generateOAuthState()
  const redirect = new URL(CLAUDE_OAUTH_DEFAULTS.redirectUri)
  return runInteractiveOAuthLogin({
    providerLabel: 'Claude (Anthropic)',
    redirectPort: Number(redirect.port),
    redirectPath: redirect.pathname,
    authorizationUrl: buildClaudeAuthorizationUrl(pkce, state),
    expectedState: state,
    exchangeCode: (code, receivedState) => exchangeClaudeCode(code, receivedState, pkce),
    tokenFilePath,
  })
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  const tokenFilePath = process.argv[2]
  if (!tokenFilePath) {
    process.stderr.write('Uso: tsx src/providers/oauth/login-claude.ts <caminho-do-arquivo-de-token>\n')
    process.exit(2)
  }
  loginClaude(tokenFilePath)
    .then((token) => {
      process.stdout.write(`Login Claude concluído para ${token.email ?? 'conta autenticada'}.\n`)
    })
    .catch((error: unknown) => {
      process.stderr.write(`Falha no login Claude: ${error instanceof Error ? error.message : 'erro desconhecido'}\n`)
      process.exit(1)
    })
}
