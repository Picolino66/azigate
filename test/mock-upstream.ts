import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

export type MockHandler = (request: RecordedRequest, response: ServerResponse) => void | Promise<void>

export class MockUpstream {
  readonly requests: RecordedRequest[] = []
  private server?: Server
  private handler: MockHandler = (_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'handler ausente' }))
  }

  setHandler(handler: MockHandler): void {
    this.handler = handler
  }

  async start(): Promise<URL> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const recorded: RecordedRequest = {
          method: request.method ?? '',
          url: request.url ?? '',
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }
        this.requests.push(recorded)
        void Promise.resolve(this.handler(recorded, response)).catch(() => {
          if (!response.headersSent) response.writeHead(500)
          response.end()
        })
      })
    })
    this.server.on('connection', (socket) => {
      socket.unref()
    })
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
    const address = this.server.address() as AddressInfo
    return new URL(`http://127.0.0.1:${address.port}/`)
  }

  async close(): Promise<void> {
    if (!this.server) return
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}

export function jsonResponse(response: ServerResponse, status: number, body: unknown, headers = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(body))
}
