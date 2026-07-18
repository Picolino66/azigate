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
  - [DeepSeek](./modules/providers/deepseek.md)
  - [Codex CLI](./modules/providers/codex-cli.md)
  - [Claude CLI](./modules/providers/claude-cli.md)

## Operação

- [Instalação e operação do broker](./operations/broker.md)
- [Configuração do Qwen Code](./operations/qwen-code.md)

## Segurança

- [Threat model](./security/threat-model.md)
- [Inventário de endpoints](./security/endpoint-inventory.md)
- [Revisão de 16/07/2026](./security/2026-07-16-security-review.md)
- [Plano de correção de 16/07/2026](./security/2026-07-16-remediation-plan.md)
- [Revisão estável anterior](./security/2026-07-14-security-review.md)

## Decisões arquiteturais

- [ADR-001 — monólito modular](../adr/ADR-001-monolito-modular-fastify.md)
- [ADR-002 — upstream fixo e contrato opaco](../adr/ADR-002-upstream-fixo-e-contrato-opaco.md)
- [ADR-003 — streaming byte a byte](../adr/ADR-003-streaming-byte-a-byte.md)
- [ADR-004 — segredos e observabilidade](../adr/ADR-004-segredos-e-observabilidade-minima.md)
- [ADR-005 — registry e broker local](../adr/ADR-005-registro-multiprovedor-e-broker-local.md)
- [ADR-006 — Qwen como único executor](../adr/ADR-006-qwen-como-unico-executor.md)
- [ADR-007 — streaming dividido](../adr/ADR-007-streaming-dividido-por-provedor.md)
- [ADR-008 — aliases Codex com modelo fixo](../adr/ADR-008-aliases-codex-com-modelo-fixo.md)
- [ADR-009 — Claude CLI com esforço configurável](../adr/ADR-009-claude-cli-esforco-configuravel.md)

## Regra de sincronização

Mudanças de comportamento, contrato, configuração, dependência ou fluxo exigem atualização do módulo correspondente, deste índice, das specs e, quando aplicável, de ADR/threat model/README/env.
