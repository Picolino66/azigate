import { resolve } from 'node:path'
import { packVscodeExtension } from './vscode-package.js'

// npm run pack:vscode → dist-vscode/azigate-vscode-<versão>.vsix
try {
  const file = await packVscodeExtension(resolve(process.argv[2] ?? 'dist-vscode'))
  process.stdout.write(`${file}\n`)
} catch (error) {
  process.stderr.write(`pack:vscode: ${error instanceof Error ? error.message : 'erro desconhecido'}\n`)
  process.exit(1)
}
