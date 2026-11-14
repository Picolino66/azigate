# Servidor MCP do workspace

## Descrição

Servidor MCP (JSON-RPC 2.0) das capacidades de um workspace, agnóstico ao agente. É o servidor
que Claude Code, Codex e AGY consomem quando operam o projeto da máquina B.

## Localização no código

- `src/workspace/mcp/server.ts` — `WorkspaceMcpServer`, `toolDefinitions`, `formatToolResult`.
- `src/workspace/protocol/protocol.ts` — métodos, esquemas e conjuntos somente leitura/execução.
- `src/agentd/mcp-bridge/` — ponte stdio que os agentes iniciam na máquina A.
- `src/agent-control/workspace-relay.ts` — relay e política no agentd.

## Entrada

`initialize`, `notifications/initialized`, `ping`, `server/discover`, `tools/list`,
`tools/call`.

## Saída

16 ferramentas — `list_directory`, `find_file`, `search`, `read_file`, `write_file`,
`edit_file`, `mkdir`, `delete`, `git_status`, `git_diff`, `git_log`, `shell_exec`,
`process_start`, `process_stdin`, `process_output`, `process_kill` — com `annotations`
(`readOnlyHint` nas sete de leitura, `destructiveHint` nas demais, `openWorldHint` na execução).
Leitura de arquivo e Git voltam como texto bruto; o resto, como JSON.

## Dependências

Handler do workspace (arquivos, Git, processos).

## Regras de negócio

- Erro de ferramenta é resultado `isError: true` com `"<código>: <mensagem>"`; o agente vê e
  continua. Ferramenta desconhecida é erro de protocolo `-32602`.
- `server/discover` responde `{}` (o AGY o envia antes do `initialize`).
- No transporte remoto, a política (plan, aprovações) é aplicada pelo relay do agentd antes de a
  chamada chegar aqui; no modo stdio, a aprovação é do cliente MCP.

## Fluxo resumido

agente → ponte (A) → relay (A: token, política) → canal WebSocket → `WorkspaceMcpServer` (B) →
handler → resposta pelo mesmo caminho.

## Possíveis erros

`-32600`, `-32601`, `-32602` e os códigos de ferramenta da
[especificação](../../../specs/workspace-protocol.md#métodos).
