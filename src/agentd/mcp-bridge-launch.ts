import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { McpBridgeLaunch } from '../agent-control/sessions.js'

/**
 * Como o Claude Code inicia o `azigate-mcp-bridge`: o mesmo Node.js do agentd executando o
 * módulo compilado. Em desenvolvimento (`tsx`), usa o fonte TypeScript via `--import tsx`.
 */
export function defaultMcpBridgeLaunch(): Omit<McpBridgeLaunch, 'socketPath'> {
  const compiled = fileURLToPath(new URL('../mcp-bridge/main.js', import.meta.url))
  if (existsSync(compiled)) return { command: process.execPath, args: [compiled] }
  const source = fileURLToPath(new URL('../mcp-bridge/main.ts', import.meta.url))
  return { command: process.execPath, args: ['--import', 'tsx', source] }
}
