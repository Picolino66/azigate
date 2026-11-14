import { connect } from 'node:net'
import { LineSplitter, parseJsonLine } from '../../agents/core/ndjson.js'
import { idleMcpResponse, readBridgeSession } from './session-file.js'

// azigate-mcp-bridge: servidor MCP stdio que os agentes (Claude, Codex, AGY) iniciam na
// máquina A. É um cano: repassa JSON-RPC ao relay do agentd, que o leva ao Workspace Server
// da máquina B (ADR-025). Sem AZIGATE_MCP_SESSION, expõe zero ferramentas.
const MAX_LINE_BYTES = 16 * 1024 * 1024
const sessionPath = process.env.AZIGATE_MCP_SESSION

function writeOut(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

if (!sessionPath) {
  const splitter = new LineSplitter(MAX_LINE_BYTES, (line) => {
    const reply = idleMcpResponse(parseJsonLine(line))
    if (reply) writeOut(reply)
  }, () => undefined)
  process.stdin.on('data', (chunk: Buffer) => splitter.push(chunk))
  process.stdin.on('end', () => process.exit(0))
} else {
  let session
  try {
    session = readBridgeSession(sessionPath)
  } catch (error) {
    process.stderr.write(`azigate-mcp-bridge: ${error instanceof Error ? error.message : 'sessão inválida'}\n`)
    process.exit(2)
  }
  const socket = connect(session.socket)
  socket.write(`${JSON.stringify({ type: 'hello', token: session.token })}\n`)
  const fromAgentd = new LineSplitter(MAX_LINE_BYTES, (line) => {
    const message = parseJsonLine(line)
    if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'error') {
      process.stderr.write(`azigate-mcp-bridge: ${String((message as { code?: unknown }).code)}\n`)
      process.exit(3)
    }
    process.stdout.write(`${line}\n`)
  }, () => socket.destroy())
  const fromAgent = new LineSplitter(MAX_LINE_BYTES, (line) => socket.write(`${line}\n`), () => undefined)
  socket.on('data', (chunk: Buffer) => fromAgentd.push(chunk))
  socket.on('error', () => process.exit(4))
  socket.on('close', () => process.exit(0))
  process.stdin.on('data', (chunk: Buffer) => fromAgent.push(chunk))
  process.stdin.on('end', () => socket.end())
}
