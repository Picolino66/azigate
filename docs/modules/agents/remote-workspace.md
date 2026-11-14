# Workspace remoto: agentes em A, projeto em B

## Descrição

Com `worker` na criação da sessão, **Claude Code, Codex e AGY rodam completos na máquina A** e
trabalham sobre o projeto que continua na **máquina B**, alcançado pelo
[Workspace Server](../workspace/index.md) via MCP. Não há cópia, `rsync`, `sshfs` nem `git
clone` do projeto em A ([ADR-025](../../../adr/ADR-025-workspace-server-mcp-para-os-tres-agentes.md)).

```text
Claude A ─┐
Codex A  ─┼─ MCP ─► azigate-mcp-bridge (A) ─► relay do agentd (A) ─WS─► Workspace Server (B) ─► projeto
AGY A    ─┘
```

## Localização no código

- `src/agent-control/sessions.ts` — `workspaceTarget`: token, `mcp-session.json`, lançamento
  da ponte e instruções.
- `src/agent-control/workspace-relay.ts` — relay e política (`plan`, aprovações).
- `src/agents/claude/claude-provider.ts`, `src/agents/codex/codex-provider.ts`,
  `src/agents/agy/agy-provider.ts` e `src/agents/agy/agy-remote-setup.ts` — isolamento por
  agente.
- `src/agents/core/remote-workspace.ts` — instrução que informa ao agente onde o projeto está.

## Entrada

`POST /agent/v1/sessions` com `provider`, `worker` e `workspace` publicados pelo Workspace
Server.

## Saída

Ferramentas `mcp__azigate_workspace__<ferramenta>` nos três agentes; eventos `tool.started` com
`summary`.

## Dependências

`WORKER_ENABLED=true`, Workspace Server conectado com capacidade `mcp`, a ponte
(`dist/agentd/mcp-bridge/main.js`, ou o fonte via `tsx` em desenvolvimento) e, para o AGY, a
preparação remota.

## Regras de negócio

| | Claude Code | Codex | AGY |
|---|---|---|---|
| Runtime | `claude -p` stream-json (A) | `codex app-server` (A) | `agy` stream-json (A) |
| Como recebe o MCP | `--mcp-config` + `--strict-mcp-config` | `-c mcp_servers.azigate_workspace.*` | servidor global `azigate_workspace` herdando `AZIGATE_MCP_SESSION` |
| Ferramentas locais de A | só `Task`, `TodoWrite`, `WebFetch`, `WebSearch` | sem shell, exec, navegador e computer use; `sandbox: read-only`; outros MCP do usuário desligados | agente `azigate-workspace` com `excludeDefaultComponents: true` |
| cwd | diretório vazio e privado da sessão | idem | idem |
| Aprovação das ferramentas remotas | nativa (`can_use_tool`) | relay do agentd | relay do agentd |
| Instruções | `--append-system-prompt` | `developerInstructions` | corpo do agente |

- O token do relay fica só em `mcp-session.json` (`0600`); a configuração MCP de cada agente
  tem apenas o caminho. Token revogado ao fechar a sessão ou quando o processo morre.
- `plan` recusa escrita e execução no relay, para qualquer agente.
- Codex: ações nativas (comando/arquivo em A) sempre negadas em sessão remota.
- AGY: o agentd prepara servidor MCP, agente e regras `mcp(azigate_workspace/…)` no startup
  (`AGY_REMOTE_AUTO_SETUP`, padrão `true`); `npm run agy:remote -- install|status|uninstall`.
- Retomada e cancelamento seguem os mecanismos nativos de cada agente
  ([sessões](./sessions.md)).

## Fluxo resumido

criar sessão → worker conectado com MCP? → token + `mcp-session.json` → agente inicia a ponte
pelo mecanismo dele → `tools/call` → relay (token, `plan`, aprovação) → canal → Workspace Server
→ projeto em B.

## Possíveis erros

`503 worker_unavailable` (desconectado ou sem MCP), `404 workspace_not_found`,
`502 agent_start_failed` (por exemplo, AGY sem preparação). Nas ferramentas:
`permission_denied`, `worker_unavailable`, `timeout` e os códigos do workspace.
