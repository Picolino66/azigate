import { resolve } from 'node:path'
import { packClient } from './client-package.js'

// npm run pack:client → dist-client/azigate-client-<versão>.tgz
try {
  const file = await packClient(resolve(process.argv[2] ?? 'dist-client'))
  process.stdout.write(`${file}\n`)
} catch (error) {
  process.stderr.write(`pack:client: ${error instanceof Error ? error.message : 'erro desconhecido'}\n`)
  process.exit(1)
}
