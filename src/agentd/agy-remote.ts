import 'dotenv/config'
import { agyRemoteStatus, installAgyRemote, uninstallAgyRemote } from '../agents/agy/agy-remote-setup.js'
import { defaultMcpBridgeLaunch } from './mcp-bridge-launch.js'

// npm run agy:remote -- install | status | uninstall
// Prepara (ou desfaz) o AGY para workspace remoto: servidor MCP `azigate_workspace`, agente
// `azigate-workspace` e regras `mcp(azigate_workspace/<ferramenta>)` (ADR-025).
const action = process.argv[2] ?? 'status'
const home = process.env.HOME ?? ''
const binary = process.env.AGY_BINARY?.trim() || 'agy'

try {
  let status
  if (action === 'install') status = await installAgyRemote({ binary, home, bridge: defaultMcpBridgeLaunch() })
  else if (action === 'uninstall') status = await uninstallAgyRemote({ binary, home })
  else if (action === 'status') status = agyRemoteStatus(home)
  else throw new Error('Use install, status ou uninstall')
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`agy:remote: ${error instanceof Error ? error.message : 'erro desconhecido'}\n`)
  process.exit(1)
}
