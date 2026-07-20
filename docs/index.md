# Índice de documentação

`/docs` é a fonte primária de contexto do `gateway-ai`. Comece por este arquivo e pelo módulo afetado antes de abrir o código.

## Sistema

- [Arquitetura](./architecture.md)
- [Contexto canônico do orquestrador](./orchestrator-context.json)
- [Contrato público](../specs/gateway-api.md)
- [OpenAPI](../specs/openapi.yaml)
- [Protocolo privado do broker](../specs/broker-api.md)
- [Plano rastreável](../tasks/implementation-plan.md)

## Módulos

- [Providers](./modules/providers/index.md)
  - [Upstream OpenAI-compatible (DeepSeek por padrão)](./modules/providers/deepseek.md)
  - [Codex CLI](./modules/providers/codex-cli.md)
  - [Claude CLI](./modules/providers/claude-cli.md)
- [Observabilidade](./modules/observability/index.md)
  - [Logs de requisição](./modules/observability/logs.md)

## Instalação

- [Instalação no Linux](./installation/linux.md)
- [Instalação no Windows (WSL2)](./installation/windows-wsl2.md)

## Operação

- [Configurar um agente OpenAI-compatible](./operations/openai-compatible-agents.md)
- [Instalação e operação do broker](./operations/broker.md)
- [Configuração do Qwen Code](./operations/qwen-code.md)
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
- [ADR-006 — Agente cliente como único executor](../adr/ADR-006-qwen-como-unico-executor.md)
- [ADR-007 — streaming dividido](../adr/ADR-007-streaming-dividido-por-provedor.md)
- [ADR-008 — aliases Codex com modelo fixo](../adr/ADR-008-aliases-codex-com-modelo-fixo.md)
- [ADR-009 — Claude CLI com esforço configurável](../adr/ADR-009-claude-cli-esforco-configuravel.md)
- [ADR-010 — aliases Claude com modelo fixo](../adr/ADR-010-aliases-claude-com-modelo-fixo.md)
- [ADR-011 — effort do Qwen para provedores CLI](../adr/ADR-011-effort-qwen-para-provedores-cli.md)
- [ADR-012 — configuração Claude em home efêmero](../adr/ADR-012-configuracao-claude-em-home-efemero.md)
- [ADR-013 — check Codex por catálogo estruturado](../adr/ADR-013-check-de-capacidade-codex-por-catalogo.md)

## Regra de sincronização

Mudanças de comportamento, contrato, configuração, dependência ou fluxo exigem atualização do módulo correspondente, deste índice, das specs e, quando aplicável, de ADR/threat model/README/env.
