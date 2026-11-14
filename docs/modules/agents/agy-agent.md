# Provider AGY (Google Antigravity CLI headless)

## Descrição

Integra o AGY como agente completo pelo modo headless `stream-json`: um processo vivo e
uma linha de entrada por turno. O Azigate não cria OAuth para o AGY; a CLI usa as
credenciais do login interativo feito pelo operador.

## Localização no código

- `src/agents/agy/agy-provider.ts` — `AgyAgentProvider`, `buildAgyArgs`, saúde.
- `src/agents/agy/agy-session.ts` — `AgySession` (init, turnos, cancelamento).
- `src/agents/agy/agy-events.ts` — mapeamento de `init`, `step_update` e `result`.

## Entrada

`model`, `effort` (`low`, `medium`, `high`), `permissionMode`, workspace local ou remoto
(máquina B).

## Saída

Eventos universais com a linha NDJSON original em `native`; `nativeSessionId` é o
`conversation_id`.

## Dependências

Binário `agy` (`AGY_BINARY`) autenticado; nenhuma variável extra.

## Regras de negócio

- Argv: `--input-format stream-json --output-format stream-json`, mais
  `--conversation <id>` (retomada), `--model`, `--effort` e `--mode` (`accept-edits` ou
  `plan`). `review` mantém o modo padrão `request-review`. Nunca
  `--dangerously-skip-permissions`.
- Formato verificado na CLI 1.2.10: a saída usa o campo `event` (`init`, `step_update`,
  `result`); a entrada exige `{"event":"user","message":{"role":"user","content":...}}`;
  `control_request` não é suportado.
- A criação espera o `init` (≈ 5 s na CLI real) para obter o `conversation_id`.
- **Retomada segura**: o AGY cria uma conversa nova, em silêncio, quando o ID de
  `--conversation` não existe. O adaptador compara o `conversation_id` do `init` com o
  pedido e falha a retomada (`AgentResumeError`) em vez de perder o contexto.
- `step_update` é mapeado de forma tolerante (`tool_info` → `tool.*`, `subagent_info` →
  `subagent.*`, deltas de texto); o formato das etapas de ferramenta foi confirmado em turnos
  reais em 25/09/2026. Tudo que não for reconhecido segue como `provider.event`.
- Cancelamento: `SIGINT` no grupo de processos (não há controle pela entrada); sem saída
  no prazo, `SIGTERM`/`SIGKILL`. A sessão fica `suspended` e retoma no próximo turno.
- Sem canal de aprovação headless: ações que exigiriam revisão são negadas pela CLI.
- Workspace remoto (ADR-025): o AGY 1.2.x não aceita MCP por sessão, então o agentd prepara
  uma vez (`installAgyRemote`, idempotente): servidor global `azigate_workspace`
  (`agy mcp add`), agente de usuário `~/.gemini/config/agents/azigate-workspace.md` com
  `excludeDefaultComponents: true` (sem arquivos, terminal e navegador da máquina A; mantém
  `call_mcp_tool`) e as regras `mcp(azigate_workspace/<ferramenta>)` em
  `~/.gemini/antigravity-cli/settings.json` (sem elas o headless nega MCP). A sessão roda com
  `--agent azigate-workspace`, cwd vazio e `AZIGATE_MCP_SESSION` no ambiente, que a ponte
  herda. Fora do Azigate a ponte não expõe ferramentas. Aprovações das ferramentas remotas são
  feitas pelo agentd. Subagentes embutidos do AGY não ficam disponíveis nesse modo.
- Chamadas `call_mcp_tool` (`tool_info.parameters.{ServerName,ToolName,Arguments}`) viram
  `mcp__<servidor>__<ferramenta>` com `summary`; `state` `ACTIVE|DONE|ERROR` é o formato
  observado na CLI 1.2.11.
- Saúde: `agy --version` e `agy -p=/model --output-format json` (comando respondido pela
  própria CLI, sem consumir cota).

## Fluxo resumido

spawn → `init` (`session.started`) → linha `user` → `step_update`* → `result`
(`SUCCESS` → `turn.completed`; `ERROR` → `agent_turn_failed`).

## Possíveis erros

`AgentStartError` (sem `init`), `AgentResumeError`, `turn.failed` com
`agent_turn_failed`, `turn_cancelled` ou `agent_process_exited`.
