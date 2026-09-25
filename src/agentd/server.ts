import 'dotenv/config'
import { createAgentdApp } from './app.js'
import { loadAgentdConfig } from './config.js'

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 13)) {
  console.error('O azigate-agentd exige Node.js >= 22.13 (node:sqlite sem flag).')
  process.exit(1)
}

let runtime: Awaited<ReturnType<typeof createAgentdApp>>
try {
  const config = loadAgentdConfig()
  runtime = await createAgentdApp(config)
  await runtime.app.listen({ host: config.host, port: config.port })
} catch (error) {
  console.error(`Falha ao iniciar o azigate-agentd: ${error instanceof Error ? error.message : 'erro desconhecido'}`)
  process.exit(1)
}

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  runtime.app.log.info({ signal, event: 'graceful_shutdown_started' })
  const forceExit = setTimeout(() => process.exit(1), 20_000)
  forceExit.unref()
  try {
    await runtime.app.close()
    clearTimeout(forceExit)
    process.exit(0)
  } catch (error) {
    runtime.app.log.error({ event: 'graceful_shutdown_failed', error: error instanceof Error ? error.name : 'UnknownError' })
    process.exit(1)
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdown(signal)
  })
}
