import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { McpBridgeLaunch } from '../agent-control/sessions.js'

/**
 * Como os agentes (Claude, Codex, AGY) iniciam o `azigate-mcp-bridge`: o mesmo Node.js do agentd executando o
 * módulo compilado. Em desenvolvimento (`tsx`), usa o fonte TypeScript via `--import tsx`.
 */
export function defaultMcpBridgeLaunch(): Omit<McpBridgeLaunch, 'socketPath'> {
  const compiled = fileURLToPath(new URL('./mcp-bridge/main.js', import.meta.url))
  if (existsSync(compiled)) return { command: process.execPath, args: [compiled] }
  const source = fileURLToPath(new URL('./mcp-bridge/main.ts', import.meta.url))
  // Caminho absoluto: a ponte roda com cwd no diretório da sessão, fora do repositório.
  return { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), source] }
}
