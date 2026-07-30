# Incidentes operacionais

> Os incidentes de 22 e 23/07/2026 abaixo têm causa raiz na tradução de semântica
> OpenAI via linguagem natural pelo broker CLI (envelope de decisão validado pelo
> próprio modelo, flags internas voláteis do App Server). Essa classe de causa foi
> eliminada pela migração para adaptadores HTTP nativos com tradução determinística
> em código — ver [ADR-016](../../../adr/ADR-016-substituicao-do-broker-por-adaptadores-http.md),
> [ADR-017](../../../adr/ADR-017-fim-do-regime-sintetico-de-sse.md) e
> [ADR-018](../../../adr/ADR-018-credencial-oauth-da-assinatura.md). Os registros
> abaixo permanecem como histórico da arquitetura anterior (broker + Bubblewrap),
> já removida do código.

- [23/07/2026 — outputSchema do broker rejeitado pelo structured outputs](./2026-07-23-output-schema-rejeitado-structured-outputs.md) — **resolvido por mudança arquitetural (ADR-016)**
- [23/07/2026 — bind mount órfão do socket após restart do broker](./2026-07-23-bind-mount-orfao-do-socket.md) — **resolvido por mudança arquitetural (ADR-016, socket removido)**
- [23/07/2026 — broker interrompe retry do App Server Codex](./2026-07-23-codex-app-server-retry.md) — **resolvido por mudança arquitetural (ADR-016)**
- [22/07/2026 — confiabilidade de decisão Codex e Claude](./2026-07-22-confiabilidade-decisao-cli.md) — **resolvido por mudança arquitetural (ADR-016, ADR-017)**
- [20/07/2026 — aliases Codex com `invalid_cli_output` no modo memory após upgrade 0.144.6](./2026-07-20-codex-app-server-0144-invalid-cli-output.md) — histórico (broker removido)
- [20/07/2026 — telemetria CLI incompleta e reenvio de contexto](./2026-07-20-telemetria-cli-incompleta-e-reenvio-de-contexto.md) — histórico (broker removido)
- [20/07/2026 — Claude sem `.claude.json` na sandbox](./2026-07-20-claude-config-ausente-na-sandbox.md) — histórico (broker removido)
- [20/07/2026 — aliases CLI indisponíveis após o deploy](./2026-07-20-aliases-cli-indisponiveis-pos-deploy.md) — histórico (broker removido)
