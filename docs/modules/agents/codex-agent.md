# Provider Codex (`codex app-server`)

## Descrição

Integra o Codex como agente completo pelo `codex app-server` por stdio (JSON-RPC sem o
campo `jsonrpc`, como a CLI 0.144.6 fala). A thread nativa é a sessão. Não confundir com
os aliases `codex-cli-*` do Model Plane, que são **model adapters** HTTP.

## Localização no código

- `src/agents/codex/codex-provider.ts` — `CodexAgentProvider`, política por modo, saúde.
- `src/agents/codex/codex-session.ts` — `CodexSession` (initialize, thread, turnos).
- `src/agents/codex/codex-events.ts` — notificações → eventos; pedidos de aprovação.
- `src/agents/core/json-rpc.ts` — correlação de pedidos/respostas.

## Entrada

`model`, `effort` (`low`, `medium`, `high`, `xhigh`), `permissionMode` e workspace local.

## Saída

Eventos universais com a notificação JSON-RPC original em `native`; `nativeSessionId`
é o `threadId`.

## Dependências

Binário `codex` (`CODEX_BINARY`) autenticado pelo próprio `codex login`; `CODEX_HOME`
é repassado se definido.

## Regras de negócio

- Argv fixo: `codex app-server`. Handshake: `initialize` (sem `experimentalApi`) e
  `initialized`.
- `thread/start` com `cwd` do workspace; `thread/resume` com o `threadId` salvo. Thread
  diferente da pedida ou erro na retomada → `AgentResumeError` (sessão `failed`).
- Política: `review` → `approvalPolicy: untrusted` + `sandbox: workspace-write`;
  `acceptEdits` → `on-request` + `workspace-write`; `plan` → `untrusted` + `read-only`.
  Nunca `never` nem `danger-full-access`.
- Turno: `turn/start` com `input: [{type:"text", text, text_elements: []}]` e `effort`.
  Cancelamento: `turn/interrupt`. `turn/completed` com `interrupted` → `turn_cancelled`;
  `failed` → `agent_turn_failed`.
- Itens `commandExecution`, `fileChange`, `mcpToolCall` (`mcp__<servidor>__<ferramenta>`),
  `dynamicToolCall`, `webSearch`, `imageGeneration`, `imageView` viram `tool.*`;
  `collabAgentToolCall` vira `subagent.*`.
- Pedidos do servidor suportados: aprovações de comando, arquivo, permissões e os legados
  `execCommandApproval`/`applyPatchApproval`. Os demais recebem `-32601`.
- Workspace remoto não é suportado (ADR-023).
- Saúde: `codex --version` e `codex login status` (código 0 = autenticado).

## Fluxo resumido

spawn → `initialize` → `initialized` → `thread/start|resume` → `session.started` →
`turn/start` → notificações → `turn/completed`.

## Possíveis erros

`AgentStartError` (app-server não inicializou), `AgentResumeError`, `turn.failed` com
`agent_turn_failed`, `turn_cancelled`, `agent_process_exited` ou `agent_protocol_error`.
