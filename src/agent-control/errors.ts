/** Erro público do Agent Plane: status HTTP, código estável e mensagem sanitizada. */
export class AgentPlaneError extends Error {
  override readonly name = 'AgentPlaneError'

  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage)
  }
}

export function agentErrorBody(message: string, code: string): object {
  return { error: { message, type: 'agent_error', code } }
}

export const notFound = (): AgentPlaneError => new AgentPlaneError(404, 'session_not_found', 'Sessão não encontrada')
