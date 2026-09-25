# Índice de documentação

`/docs` é a fonte primária de contexto do `azigate`. Comece por este arquivo e pelo módulo afetado antes de abrir o código.

## Sistema

- [Arquitetura](./architecture.md)
- [Contexto canônico do orquestrador](./orchestrator-context.json)
- [Contrato público](../specs/gateway-api.md)
- [OpenAPI](../specs/openapi.yaml)
- [Contrato do Agent Plane](../specs/agent-api.md) e [OpenAPI do Agent Plane](../specs/agent-openapi.yaml)
- [Protocolo do worker e da ponte MCP](../specs/worker-protocol.md)
- [Plano rastreável](../tasks/implementation-plan.md)
- [Plano de confiabilidade de execução CLI](../tasks/cli-execution-reliability-plan.md)
- [Plano do Native Agent Plane](../tasks/native-agent-plane-plan.md)

## Módulos

- [Agent Plane (agentes nativos)](./modules/agents/index.md)
  - [Serviço azigate-agentd](./modules/agents/agentd.md)
  - [Sessões e turnos](./modules/agents/sessions.md)
  - [Eventos e endpoint nativo](./modules/agents/events.md)
  - [Aprovações](./modules/agents/approvals.md)
  - [Provider Codex](./modules/agents/codex-agent.md)
  - [Provider Claude Code](./modules/agents/claude-agent.md)
  - [Provider AGY](./modules/agents/agy-agent.md)
  - [Worker remoto](./modules/agents/worker.md)
  - [Workspace remoto via MCP](./modules/agents/remote-workspace-mcp.md)
- [Providers do Model Plane (model adapters)](./modules/providers/index.md)
  - [Upstream OpenAI-compatible (DeepSeek por padrão)](./modules/providers/deepseek.md)
  - [Codex CLI](./modules/providers/codex-cli.md)
  - [Claude CLI](./modules/providers/claude-cli.md)
  - [Renovação de token OAuth](./modules/providers/oauth-token-renewal.md)
- [Camada de tradução](./modules/translation/index.md)
  - [OpenAI → Anthropic (requisição)](./modules/translation/openai-to-anthropic.md)
  - [Anthropic → OpenAI (stream)](./modules/translation/anthropic-to-openai.md)
  - [OpenAI → Responses/Codex (requisição)](./modules/translation/openai-to-responses.md)
  - [Responses/Codex → OpenAI (stream)](./modules/translation/responses-to-openai.md)
- [Observabilidade](./modules/observability/index.md)
  - [Logs de requisição](./modules/observability/logs.md)

## Instalação

- [Instalação no Linux](./installation/linux.md)
- [Instalação no Windows (WSL2)](./installation/windows-wsl2.md)

## Operação

- [Configurar um agente OpenAI-compatible](./operations/openai-compatible-agents.md)
- [Configuração do Qwen Code](./operations/qwen-code.md)
- [Runbook do Agent Plane](./operations/agent-plane.md)
- [Incidentes operacionais](./operations/incidents/index.md)

## Segurança

- [Threat model](./security/threat-model.md)
- [Inventário de endpoints](./security/endpoint-inventory.md)
- [Revisão de 16/07/2026](./security/2026-07-16-security-review.md)
- [Plano de correção de 16/07/2026](./security/2026-07-16-remediation-plan.md)
- [Revisão estável anterior](./security/2026-07-14-security-review.md)
- [Verificação da configuração Claude isolada](./security/2026-07-20-claude-config-isolation-verification.md)

## Decisões arquiteturais

- [ADR-001 — monólito modular](../adr/ADR-001-monolito-modular-fastify.md)
- [ADR-002 — upstream fixo e contrato opaco](../adr/ADR-002-upstream-fixo-e-contrato-opaco.md)
- [ADR-003 — streaming byte a byte](../adr/ADR-003-streaming-byte-a-byte.md)
- [ADR-004 — segredos e observabilidade](../adr/ADR-004-segredos-e-observabilidade-minima.md)
- [ADR-005 — registry e broker local](../adr/ADR-005-registro-multiprovedor-e-broker-local.md)
- [ADR-006 — Agente cliente como único executor (Model Plane)](../adr/ADR-006-qwen-como-unico-executor.md)
- [ADR-007 — streaming dividido](../adr/ADR-007-streaming-dividido-por-provedor.md)
- [ADR-008 — aliases Codex com modelo fixo](../adr/ADR-008-aliases-codex-com-modelo-fixo.md)
- [ADR-009 — Claude CLI com esforço configurável](../adr/ADR-009-claude-cli-esforco-configuravel.md)
- [ADR-010 — aliases Claude com modelo fixo](../adr/ADR-010-aliases-claude-com-modelo-fixo.md)
- [ADR-011 — effort do Qwen para provedores CLI](../adr/ADR-011-effort-qwen-para-provedores-cli.md)
- [ADR-012 — configuração Claude em home efêmero](../adr/ADR-012-configuracao-claude-em-home-efemero.md)
- [ADR-013 — check Codex por catálogo estruturado](../adr/ADR-013-check-de-capacidade-codex-por-catalogo.md)
- [ADR-014 — sessões CLI efêmeras em memória e usage por provider](../adr/ADR-014-sessoes-cli-efemeras-em-memoria-e-usage-por-provider.md)
- [ADR-015 — telemetria segura e schema de decisão CLI](../adr/ADR-015-telemetria-segura-e-schema-decisao-cli.md)
- [ADR-016 — substituição do broker por adaptadores HTTP](../adr/ADR-016-substituicao-do-broker-por-adaptadores-http.md)
- [ADR-017 — fim do regime sintético de SSE](../adr/ADR-017-fim-do-regime-sintetico-de-sse.md)
- [ADR-018 — credencial OAuth da assinatura](../adr/ADR-018-credencial-oauth-da-assinatura.md)
- [ADR-019 — adaptadores CLI sempre consomem SSE](../adr/ADR-019-adaptadores-cli-sempre-consomem-sse.md)
- [ADR-020 — `prompt_cache_key` derivada da conversa](../adr/ADR-020-prompt-cache-key-derivada-da-conversa.md)
- [ADR-021 — catálogo Claude da geração 5](../adr/ADR-021-catalogo-claude-geracao-5.md)
- [ADR-022 — Agent Plane nativo e separado](../adr/ADR-022-agent-plane-nativo.md)
- [ADR-023 — worker remoto e isolamento de workspace](../adr/ADR-023-worker-remoto-e-isolamento-de-workspace.md)
- [ADR-024 — persistência de sessões e dependências do Agent Plane](../adr/ADR-024-persistencia-de-sessoes-e-dependencias-do-agent-plane.md)

## Regra de sincronização

Mudanças de comportamento, contrato, configuração, dependência ou fluxo exigem atualização do módulo correspondente, deste índice, das specs e, quando aplicável, de ADR/threat model/README/env.
