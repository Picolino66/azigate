import 'dotenv/config'
import { readValue } from '../config.js'
import { signWorkerToken } from '../worker-protocol/security.js'

// npm run worker:token -- --worker devbox --workspace backend [--workspace frontend] [--days 90]
function parse(argv: readonly string[]): { workerId: string; workspaces: string[]; days: number } {
  let workerId: string | undefined
  const workspaces: string[] = []
  let days = 90
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`Valor ausente para ${flag ?? ''}`)
    if (flag === '--worker') workerId = value
    else if (flag === '--workspace') workspaces.push(value)
    else if (flag === '--days') days = Number(value)
    else throw new Error(`Argumento desconhecido: ${flag ?? ''}`)
  }
  if (!workerId) throw new Error('Informe --worker <id>')
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new Error('--days deve ficar entre 1 e 3650')
  return { workerId, workspaces, days }
}

try {
  const options = parse(process.argv.slice(2))
  const secret = readValue(process.env, 'WORKER_TOKEN_SECRET')?.trim()
  if (!secret) throw new Error('Defina WORKER_TOKEN_SECRET ou WORKER_TOKEN_SECRET_FILE')
  const token = signWorkerToken(secret, {
    workerId: options.workerId,
    workspaces: options.workspaces,
    ttlSeconds: options.days * 86_400,
  })
  process.stdout.write(`${token}\n`)
} catch (error) {
  process.stderr.write(`worker:token: ${error instanceof Error ? error.message : 'erro desconhecido'}\n`)
  process.exit(1)
}
