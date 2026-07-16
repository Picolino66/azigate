import 'dotenv/config'
import { createApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const app = createApp(config)

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  app.log.info({ signal, event: 'graceful_shutdown_started' })
  const forceExit = setTimeout(() => process.exit(1), 15_000)
  forceExit.unref()
  try {
    await app.close()
    clearTimeout(forceExit)
    process.exit(0)
  } catch (error) {
    app.log.error({ event: 'graceful_shutdown_failed', error: error instanceof Error ? error.name : 'UnknownError' })
    process.exit(1)
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdown(signal)
  })
}

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.fatal({ event: 'startup_failed', error: error instanceof Error ? error.name : 'UnknownError' })
  process.exit(1)
}
