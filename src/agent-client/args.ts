import type { ChatOptions } from './chat.js'

export const USAGE = `Uso:
  azigate-agent chat <claude|codex|agy> <workspace> [--worker id] [--local] [--model m]
                     [--effort e] [--mode review|acceptEdits|plan] [--resume agt_…] [--keep] [--reasoning]
  azigate-agent providers
  azigate-agent workers

Configuração: ~/.config/azigate/agent.json e agent.key (gerados pelo client:setup na máquina A),
ou AZIGATE_AGENT_URL (padrão http://127.0.0.1:3100) e AZIGATE_AGENT_KEY / AZIGATE_AGENT_KEY_FILE.`

export function parseChatArgs(argv: readonly string[]): ChatOptions {
  const [provider, workspace, ...rest] = argv
  if (!provider || !workspace) throw new Error(USAGE)
  const options: ChatOptions = { provider, workspace }
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] ?? ''
    const take = (): string => {
      const value = rest[index + 1]
      if (value === undefined) throw new Error(`Valor ausente para ${flag}`)
      index += 1
      return value
    }
    switch (flag) {
      case '--worker':
        options.worker = take()
        break
      case '--model':
        options.model = take()
        break
      case '--effort':
        options.effort = take()
        break
      case '--mode':
        options.mode = take()
        break
      case '--resume':
        options.resume = take()
        break
      case '--local':
        options.local = true
        break
      case '--keep':
        options.keep = true
        break
      case '--reasoning':
        options.reasoning = true
        break
      default:
        throw new Error(`Opção desconhecida: ${flag}\n\n${USAGE}`)
    }
  }
  return options
}
