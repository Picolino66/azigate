import { LineSplitter, parseJsonLine } from '../agents/core/ndjson.js'
import { WorkspaceMcpServer } from './mcp-server.js'
import { AgentdSocketClient } from './socket-client.js'

// azigate-mcp-bridge: iniciado pelo Claude Code via --mcp-config nas sessões com worker.
const socketPath = process.env.AZIGATE_MCP_SOCKET
const token = process.env.AZIGATE_MCP_TOKEN
if (!socketPath || !token) {
  process.stderr.write('azigate-mcp-bridge: AZIGATE_MCP_SOCKET e AZIGATE_MCP_TOKEN são obrigatórias\n')
  process.exit(2)
}

const client = new AgentdSocketClient(socketPath, token)
const server = new WorkspaceMcpServer((tool, args) => client.call(tool, args))

const splitter = new LineSplitter(
  16 * 1024 * 1024,
  (line) => {
    server
      .handle(parseJsonLine(line) ?? { id: null })
      .then((reply) => {
        if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`)
      })
      .catch(() => undefined)
  },
  () => undefined,
)
process.stdin.on('data', (chunk: Buffer) => splitter.push(chunk))
process.stdin.on('end', () => {
  client.close()
  process.exit(0)
})
