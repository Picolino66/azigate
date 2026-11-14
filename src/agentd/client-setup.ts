import { isAbsolute } from 'node:path'
import { WORKSPACE_ID_PATTERN } from '../agent-control/workspaces.js'
import { workerConnectUrl } from '../workspace/server/config.js'
import { WORKER_ID_PATTERN } from '../workspace/security/token.js'

// Gera, na máquina A, o trecho de shell que configura a máquina B de uma vez: workspace.json,
// workspace.token, agent.json e (opcional) agent.key em ~/.config/azigate, tudo 0600.

export interface ClientSetupOptions {
  workerId: string
  /** ID → caminho absoluto na máquina B. */
  workspaces: Map<string, string>
  gateway: string
  days: number
  allowedCommands: string[] | undefined
  withAgentKey: boolean
}

export const CLIENT_SETUP_USAGE = `Uso (na máquina A):
  npm run -s client:setup -- --worker maquina-b --workspace meu-projeto=/caminho/na/maquina-b \\
    [--workspace outro=/caminho] [--gateway http://127.0.0.1:3100] [--exec npm,npx,node,git] \\
    [--days 90] [--with-agent-key]`

const COMMAND_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/u
const DELIMITER = 'AZIGATE_EOF'

export function parseClientSetupArgs(argv: readonly string[]): ClientSetupOptions {
  let workerId: string | undefined
  const workspaces = new Map<string, string>()
  let gateway = 'http://127.0.0.1:3100'
  let days = 90
  let allowedCommands: string[] | undefined
  let withAgentKey = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? ''
    if (flag === '--with-agent-key') {
      withAgentKey = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`Valor ausente para ${flag}\n${CLIENT_SETUP_USAGE}`)
    index += 1
    switch (flag) {
      case '--worker':
        workerId = value
        break
      case '--workspace': {
        const separator = value.indexOf('=')
        const id = separator > 0 ? value.slice(0, separator) : ''
        const path = separator > 0 ? value.slice(separator + 1) : ''
        if (!WORKSPACE_ID_PATTERN.test(id)) throw new Error(`--workspace: identificador inválido em "${value}" (use id=/caminho)`)
        if (!isAbsolute(path) || path.includes('\n') || path.includes('\0')) {
          throw new Error(`--workspace ${id}: o caminho na máquina B precisa ser absoluto`)
        }
        workspaces.set(id, path)
        break
      }
      case '--gateway':
        gateway = value
        break
      case '--days':
        days = Number(value)
        break
      case '--exec':
        allowedCommands = value.split(',').map((item) => item.trim()).filter(Boolean)
        break
      default:
        throw new Error(`Argumento desconhecido: ${flag}\n${CLIENT_SETUP_USAGE}`)
    }
  }
  if (!workerId || !WORKER_ID_PATTERN.test(workerId)) throw new Error(`Informe --worker <id> válido\n${CLIENT_SETUP_USAGE}`)
  if (workspaces.size === 0) throw new Error(`Informe ao menos um --workspace id=/caminho\n${CLIENT_SETUP_USAGE}`)
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new Error('--days deve ficar entre 1 e 3650')
  if (allowedCommands && (allowedCommands.length === 0 || !allowedCommands.every((item) => COMMAND_PATTERN.test(item)))) {
    throw new Error('--exec deve listar nomes de programa separados por vírgula (ex.: npm,npx,node,git)')
  }
  // Valida a URL como o Workspace Server fará (wss:// fora de loopback).
  workerConnectUrl(gateway)
  return { workerId, workspaces, gateway, days, allowedCommands, withAgentKey }
}

export interface ClientSetupSecrets {
  workspaceToken: string
  agentKey?: string
}

function heredoc(file: string, content: string): string {
  if (content.includes(DELIMITER)) throw new Error('Conteúdo inesperado no arquivo gerado')
  return `cat > "$dir/${file}" <<'${DELIMITER}'\n${content}\n${DELIMITER}`
}

/** Trecho para colar num terminal da máquina B; roda num subshell com umask 077. */
export function buildClientSetupScript(options: ClientSetupOptions, secrets: ClientSetupSecrets): string {
  const workspaceConfig = {
    gateway: options.gateway,
    workerId: options.workerId,
    tokenFile: 'workspace.token',
    workspaces: Object.fromEntries([...options.workspaces].map(([id, path]) => [id, { path }])),
    exec: options.allowedCommands ? { enabled: true, allowedCommands: options.allowedCommands } : { enabled: false },
  }
  const parts = [
    '# Cole este bloco inteiro num terminal da máquina B.',
    '(',
    'umask 077',
    'dir="${AZIGATE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/azigate}"',
    'mkdir -p "$dir" && chmod 700 "$dir" || exit 1',
    heredoc('workspace.token', secrets.workspaceToken),
    heredoc('workspace.json', JSON.stringify(workspaceConfig, null, 2)),
    heredoc('agent.json', JSON.stringify({ url: options.gateway }, null, 2)),
  ]
  if (secrets.agentKey) parts.push(heredoc('agent.key', secrets.agentKey))
  parts.push(
    'chmod 600 "$dir"/workspace.token "$dir"/workspace.json "$dir"/agent.json' + (secrets.agentKey ? ' "$dir"/agent.key' : ''),
    'echo "azigate configurado em $dir"',
    ')',
  )
  return `${parts.join('\n')}\n`
}
