# Eventos universais e endpoint nativo

## Descrição

Cada sessão tem um log de eventos numerados. Os providers traduzem as mensagens nativas
para um vocabulário mínimo comum e **sempre** anexam a mensagem original em `native`;
o que não tem tradução vira `provider.event`, nunca é descartado.

## Localização no código

- `src/agents/core/agent-event.ts` — tipos, `buildUsage`, `nativeEvent`.
- `src/agent-control/events.ts` — `SessionEventLog` (buffer circular em memória).
- `src/agents/{codex,claude,agy}/*-events.ts` — mapeamento por provider.
- `src/agentd/routes/sessions.ts` — SSE; `src/agentd/routes/native.ts` — WebSocket.

## Entrada

- `GET /agent/v1/sessions/:id/events` com `Last-Event-ID` ou `?after=<id>` opcionais.
- `WS /native/:provider/:sessionId` com `Authorization: Bearer <AGENT_API_KEY>`.

## Saída

SSE (`id`, `event`, `data`) ou frames `{id, event, native}`. Tipos:
`session.started`, `turn.started`, `message.delta`, `reasoning.delta`, `tool.started`,
`tool.completed`, `approval.required`, `approval.resolved`, `subagent.started`,
`subagent.completed`, `usage`, `turn.completed`, `turn.failed`, `session.closed`,
`provider.event`. Campos em [agent-api.md](../../../specs/agent-api.md#eventos).

## Dependências

`SessionService`, Fastify (`reply.hijack`), `@fastify/websocket`.

## Regras de negócio

- Buffer limitado por `AGENT_EVENT_BUFFER` (quantidade) e `AGENT_EVENT_BUFFER_BYTES`;
  eventos antigos são descartados e o cliente percebe pela lacuna de `id`.
- Eventos contêm conteúdo (texto, comandos, argumentos) e por isso **nunca** vão para
  log nem banco; só o dono da sessão os lê.
- Usage por provider: Claude soma `input + cache_read + cache_creation` em
  `inputTokens` e expõe `cache_read` em `cachedInputTokens`; Codex usa o breakdown
  `last` de `thread/tokenUsage/updated`; AGY usa `result.usage`
  (`thinking_tokens` → `reasoningTokens`, `cache_read_tokens` → `cachedInputTokens`).
- `turn.completed.output` traz o texto final quando o provider informa (`result.result`
  do Claude, `result.response` do AGY, última `agentMessage` do Codex).
- O endpoint nativo é somente de saída: mensagens do cliente são ignoradas, porque o
  app-server do Codex aceita `command/exec`, `fs/writeFile`, `config/value/write` e
  `account/logout` (ADR-022, decisão 9).
- O Claude recebe `--include-partial-messages`; quando há deltas parciais, o texto da
  mensagem `assistant` completa não é repetido.
- Respostas de controle do Claude (inclusive o `initialize`, que traz e-mail e
  organização da conta) nunca viram eventos.
- `keep_alive` do Claude não é repassado.

## Fluxo resumido

provider → `AgentEventDraft` → `SessionService.append` (numera, carimba `sessionId`,
`provider`, `turnId`, `timestamp`) → buffer → assinantes SSE/WebSocket.

## Possíveis erros

`404 session_not_found`, `400 invalid_request` (cursor inválido), HTTP `401` antes do
upgrade no WebSocket, fechamento `4404` (sessão de outra credencial ou provider
divergente).
