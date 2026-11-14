#!/usr/bin/env node
import { LineSplitter, parseJsonLine } from '../../agents/core/ndjson.js'
import { WorkspaceMcpServer, localToolCaller } from '../mcp/server.js'
import { loadWorkerConfig, readTokenFile } from './config.js'
import { WorkspaceConnection } from './connection.js'
import { WorkerHandler } from './handler.js'

// azigate-workspace (antigo azigate-worker): roda na máquina do projeto. Não chama modelo e
// não decide nada; só expõe o ambiente do workspace (ADR-023/ADR-025).
//   padrão      → conecta de saída no agentd e atende os agentes da máquina A
//   --mcp-stdio → servidor MCP local por stdio para um cliente MCP desta máquina
const log = (event: string, fields: Record<string, string | number | boolean> = {}): void => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`)
}

let shutdown: () => void
try {
  const config = loadWorkerConfig(process.argv.slice(2))
  const handler = new WorkerHandler(config.workspaces, config.exec)
  if (config.mode === 'mcp-stdio') {
    const workspace = config.workspace
    const server = new WorkspaceMcpServer(localToolCaller((tool, args) => handler.handle(workspace, tool, args)))
    // Respostas em andamento: com o stdin fechado, espera terminarem antes de sair.
    const pending = new Set<Promise<void>>()
    const splitter = new LineSplitter(
      16 * 1024 * 1024,
      (line) => {
        const reply = server
          .handle(parseJsonLine(line) ?? { id: null })
          .then((message) => {
            if (message) process.stdout.write(`${JSON.stringify(message)}\n`)
          })
          .catch(() => undefined)
          .finally(() => pending.delete(reply))
        pending.add(reply)
      },
      () => undefined,
    )
    process.stdin.on('data', (chunk: Buffer) => splitter.push(chunk))
    process.stdin.on('end', () => {
      void Promise.all([...pending]).then(() => {
        handler.shutdown()
        process.stdout.write('', () => process.exit(0))
      })
    })
    shutdown = () => handler.shutdown()
    log('workspace_mcp_stdio_ready', { workspace })
  } else {
    readTokenFile(config.tokenFile)
    const connection = new WorkspaceConnection({
      url: config.gatewayUrl,
      workerId: config.workerId,
      token: () => readTokenFile(config.tokenFile),
      handler,
      version: '2.0.0',
      log,
    })
    connection.start()
    shutdown = () => {
      connection.stop()
      handler.shutdown()
    }
  }
} catch (error) {
  process.stderr.write(`azigate-workspace: ${error instanceof Error ? error.message : 'erro desconhecido'}\n`)
  process.exit(1)
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    shutdown()
    process.exit(0)
  })
}
