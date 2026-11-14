import 'dotenv/config'
import { readValue } from '../config.js'
import { signWorkerToken } from '../workspace/security/token.js'
import { buildClientSetupScript, parseClientSetupArgs } from './client-setup.js'

// npm run -s client:setup -- --worker maquina-b --workspace meu-projeto=/caminho/na/b [...]
// Imprime o bloco de shell que configura a máquina B. Contém segredos: não salve em log.
try {
  const options = parseClientSetupArgs(process.argv.slice(2))
  const secret = readValue(process.env, 'WORKER_TOKEN_SECRET')?.trim()
  if (!secret) throw new Error('Defina WORKER_TOKEN_SECRET ou WORKER_TOKEN_SECRET_FILE')
  const workspaceToken = signWorkerToken(secret, {
    workerId: options.workerId,
    workspaces: [...options.workspaces.keys()],
    ttlSeconds: options.days * 86_400,
  })
  let agentKey: string | undefined
  if (options.withAgentKey) {
    agentKey = readValue(process.env, 'AGENT_API_KEYS')?.split(',').map((key) => key.trim()).find(Boolean)
    if (!agentKey) throw new Error('--with-agent-key exige AGENT_API_KEYS (ou AGENT_API_KEYS_FILE) definido')
  }
  process.stdout.write(buildClientSetupScript(options, { workspaceToken, ...(agentKey ? { agentKey } : {}) }))
} catch (error) {
  process.stderr.write(`client:setup: ${error instanceof Error ? error.message : 'erro desconhecido'}\n`)
  process.exit(1)
}
