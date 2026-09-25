import { WorkerClient } from './client.js'
import { loadWorkerConfig, readTokenFile } from './config.js'
import { WorkerHandler } from './handler.js'

// azigate-worker: roda na máquina do projeto e conecta de saída no agentd (ADR-023).
let client: WorkerClient
let handler: WorkerHandler
try {
  const config = loadWorkerConfig(process.argv.slice(2))
  readTokenFile(config.tokenFile)
  handler = new WorkerHandler(config.workspaces, config.exec)
  client = new WorkerClient({
    url: config.gatewayUrl,
    workerId: config.workerId,
    token: () => readTokenFile(config.tokenFile),
    handler,
    version: '1.0.0',
    log: (event, fields = {}) => {
      process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`)
    },
  })
} catch (error) {
  process.stderr.write(`azigate-worker: ${error instanceof Error ? error.message : 'erro desconhecido'}\n`)
  process.exit(1)
}

client.start()
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    client.stop()
    handler.shutdown()
    process.exit(0)
  })
}
