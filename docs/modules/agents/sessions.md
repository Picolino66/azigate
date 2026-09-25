# Sessões e turnos

## Descrição

Uma sessão Azigate mapeia uma sessão nativa (`threadId` do Codex, `session_id` do
Claude, `conversation_id` do AGY) e mantém, no máximo, um processo da CLI e um turno por
vez. O processo pode morrer (ociosidade, cancelamento do AGY, crash, reinício); a
sessão fica `suspended` e o próximo turno retoma pela sessão nativa.

## Localização no código

- `src/agent-control/sessions.ts` — `SessionService`.
- `src/agent-control/session-store.ts` — `SqliteSessionStore` e `MemorySessionStore`.
- `src/agent-control/workspaces.ts` — workspaces locais configurados pelo operador.
- `src/agentd/routes/sessions.ts` — rotas HTTP.

## Entrada

- `POST /agent/v1/sessions` — `provider`, `workspace`, `worker?`, `model?`, `effort?`,
  `permissionMode?`. Campos desconhecidos são recusados.
- `POST /agent/v1/sessions/:id/turns` — `{ "input": "..." }`.
- `POST /agent/v1/sessions/:id/cancel`, `DELETE /agent/v1/sessions/:id`,
  `GET /agent/v1/sessions/:id`.

## Saída

Objeto de sessão com `status`, `nativeSessionId`, versões, `currentTurn` e
`pendingApprovals`; `202` com `turnId` para turnos. O resultado do turno sai pelos
[eventos](./events.md).

## Dependências

`AgentRegistry` e providers, `ApprovalService`, `SessionEventLog`, `SessionStore`,
`WorkerHub` e `RemoteToolGateway` (sessões com worker).

## Regras de negócio

- O cliente escolhe o workspace por ID; o path vem de `AGENT_WORKSPACES_FILE` (local) ou
  da configuração do worker (remoto). Nenhum `cwd` é aceito.
- `model` não pode começar com `-` (evita injeção de flag); `effort` segue a lista do
  provider.
- Limites: `AGENT_MAX_SESSIONS` e `AGENT_MAX_SESSIONS_PER_PROVIDER` contam sessões em
  `starting`, `ready` e `running`. Retomar uma sessão também precisa de vaga.
- Um turno por vez (`409 turn_in_progress`). Timeout de turno pede interrupção e, sem
  resposta em 20 s, derruba o processo; o evento final usa `turn_timeout`.
- Cancelamento idêntico: interrupção nativa, com derrubada do processo como último
  recurso.
- Retomada que perderia o contexto (AGY cria conversa nova para ID inexistente; Codex
  recusa a thread; Claude não encontra a sessão) marca a sessão como `failed`.
- O banco guarda somente metadados (ADR-024). Eventos ficam em memória e somem 60 s após o
  fechamento.
- Sessão encerrada apaga o diretório privado dela (inclusive o `mcp-config.json`).

## Fluxo resumido

```text
create → valida → provider disponível? → resolve workspace → vaga? → grava starting
       → provider.createSession → ready → timer de ociosidade
turn   → (suspended? → provider.resumeSession) → running → turn.started
       → consome eventos → turn.completed|turn.failed → ready
idle   → fecha processo → suspended
close  → nega aprovações → derruba processo → session.closed → closed
```

## Possíveis erros

`400 invalid_request`, `400 invalid_provider`, `400 invalid_effort`,
`400 worker_not_supported_for_provider`, `404 session_not_found`,
`404 workspace_not_found`, `409 session_closed`, `409 session_failed`,
`409 turn_in_progress`, `409 no_turn_in_progress`, `429 agent_session_limit`,
`502 agent_start_failed`, `503 provider_unavailable`, `503 worker_unavailable`.
