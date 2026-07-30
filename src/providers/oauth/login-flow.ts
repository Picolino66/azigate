import { createServer } from 'node:http'
import { writeTokenFile, type StoredOAuthToken } from './token-store.js'

export interface OAuthLoginOptions {
  providerLabel: string
  redirectPort: number
  redirectPath: string
  authorizationUrl: string
  expectedState: string
  exchangeCode: (code: string, state: string) => Promise<StoredOAuthToken>
  tokenFilePath: string
}

export async function runInteractiveOAuthLogin(options: OAuthLoginOptions): Promise<StoredOAuthToken> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${options.redirectPort}`)
      if (url.pathname !== options.redirectPath) {
        response.writeHead(404)
        response.end()
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state') ?? ''
      if (!code || state !== options.expectedState) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Callback OAuth inválido: code ausente ou state divergente.')
        server.close()
        reject(new Error('Callback OAuth inválido: code ausente ou state divergente'))
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body>Login concluído. Você já pode fechar esta aba.</body></html>')
      server.close()
      options
        .exchangeCode(code, state)
        .then(async (token) => {
          await writeTokenFile(options.tokenFilePath, token)
          resolve(token)
        })
        .catch(reject)
    })
    server.on('error', reject)
    server.listen(options.redirectPort, '127.0.0.1', () => {
      process.stdout.write(`Abra esta URL no navegador para autenticar ${options.providerLabel}:\n${options.authorizationUrl}\n`)
    })
  })
}
