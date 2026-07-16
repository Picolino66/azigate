# Plano rastreável de implementação

| ID | Requisito | ADR/Spec | Implementação | Teste de aceite |
|---|---|---|---|---|
| GW-01 | autenticação e troca de chave | ADR-004, spec API | `src/security` e `src/upstream` | auth ausente/inválida/válida; header upstream |
| GW-02 | rotas fechadas e SSRF | ADR-002 | `src/upstream` e rotas Fastify | 404 em rotas extras; URL mock fixa |
| GW-03 | health/readiness | spec API | `src/routes/health.ts` | health e readiness |
| GW-04 | modelos/cache/allowlist | ADR-002 | `src/routes/models.ts` | modelos, cache e bloqueio |
| GW-05 | chat transparente | ADR-002 | `src/routes/chat.ts` | mensagens, tools, campos desconhecidos |
| GW-06 | SSE/cancelamento | ADR-003 | `src/streaming` | chunks, `[DONE]`, abort |
| GW-07 | limites e timeouts | threat model | hooks e upstream | 413, 429, 504, 502 |
| GW-08 | logs/métricas seguros | ADR-004 | `src/observability` | sanitização e metadados |
| GW-09 | deploy seguro | ADR-001 | Docker/Compose/Nginx | build, healthcheck, usuário não root |
| GW-10 | operação reproduzível | docs | README e runbook | comandos documentados e verificados localmente |

Quality gates: lint sem erros, typecheck sem erros, testes verdes, build verde, auditoria de dependências e varredura local de segredos registradas.

