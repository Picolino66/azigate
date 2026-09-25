# Provider Claude Code (`claude -p` em `stream-json`)

## Descrição

Integra o Claude Code como agente completo por um processo persistente em `stream-json`
bidirecional, com o protocolo de controle do CLI. Não confundir com os aliases
`claude-cli-*` do Model Plane, que são **model adapters** HTTP com OAuth próprio
(ADR-018): aqui o Azigate nunca toca credenciais Claude.

## Localização no código

- `src/agents/claude/claude-provider.ts` — `ClaudeAgentProvider`, `buildClaudeArgs`, saúde.
- `src/agents/claude/claude-session.ts` — `ClaudeSession` (handshake, turnos, controle).
- `src/agents/claude/claude-events.ts` — mapeamento e resumo para aprovação.

## Entrada

`model` (alias como `sonnet` ou nome completo), `effort` (`low`…`max`),
`permissionMode`, workspace local ou remoto.

## Saída

Eventos universais com a mensagem `stream-json` original em `native`;
`nativeSessionId` é o `session_id`, atribuído pelo Azigate com `--session-id`.

## Dependências

Binário `claude` (`CLAUDE_BINARY`) autenticado pelo login oficial (assinatura Pro/Max);
`CLAUDE_CONFIG_DIR` é repassado se definido.

## Regras de negócio

- Argv: `-p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --permission-prompt-tool stdio --permission-mode <modo>`
  seguido de `--session-id <uuid>` (nova) ou `--resume <id>` (retomada), e `--model`/
  `--effort` quando informados. Nunca `--dangerously-skip-permissions`.
- Modos: `review` → `manual`, `acceptEdits` → `acceptEdits`, `plan` → `plan`.
- Handshake: `control_request` `initialize`; a resposta (com dados da conta) é
  descartada. Sem resposta em 30 s, a sessão falha.
- Turno: `{"type":"user","message":{"role":"user","content":[{"type":"text",...}]}}`.
  Fim: mensagem `result` (`success` → `turn.completed`; demais → `agent_turn_failed`).
- Cancelamento: `control_request` `interrupt`; se o turno não terminar no prazo, o
  processo é derrubado.
- `can_use_tool` → [aprovação](./approvals.md); `allow` devolve o input original em
  `updatedInput`. `control_cancel_request` cancela a aprovação.
- `Task`/`Agent` geram `subagent.*`; mensagens com `parent_tool_use_id` (dentro do
  subagente) seguem como `provider.event`.
- Workspace remoto: cwd é o diretório privado da sessão e o argv ganha `--tools ""`,
  `--strict-mcp-config`, `--mcp-config <arquivo 0600>` e `--allowedTools` com as
  ferramentas somente leitura ([detalhes](./remote-workspace-mcp.md)).
- Saúde: `claude --version` e `claude auth status --json` (`loggedIn`).

## Fluxo resumido

spawn → `initialize` → pronto → linha `user` → `system/init` (`session.started`) →
deltas/ferramentas/permissões → `result`.

## Possíveis erros

`AgentStartError` (sem handshake, sessão a retomar inexistente), `turn.failed` com
`agent_turn_failed`, `turn_cancelled` ou `agent_process_exited`.
