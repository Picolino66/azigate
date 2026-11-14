import { WORKER_METHODS } from '../../workspace/protocol/protocol.js'

/**
 * Instrução anexada ao agente quando a sessão usa um workspace remoto. Ela diz ao agente
 * onde o projeto está; o isolamento de verdade vem do argv/config de cada CLI (ADR-025).
 */
export function remoteWorkspaceInstructions(workspace: string, workerId: string): string {
  return [
    `O projeto desta sessão NÃO está na máquina onde você roda. Ele está no workspace "${workspace}"`,
    `da máquina "${workerId}" e só é acessível pelas ferramentas MCP do servidor azigate_workspace`,
    `(${WORKER_METHODS.join(', ')}).`,
    'Caminhos são relativos à raiz do workspace. Comandos usam argv, sem shell.',
    'Não use ferramentas locais para ler, alterar ou executar nada do projeto.',
  ].join(' ')
}
