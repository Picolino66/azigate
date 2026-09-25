# ADR-001 — Monólito modular em Fastify

- Status: aceito
- Fase: F2
- Data: 14/07/2026

## Contexto

O projeto está vazio e entrega um único gateway stateless com três rotas públicas, uma integração upstream e nenhuma persistência.

## Opções consideradas

- Microsserviços: isolamento futuro, porém aumenta deploy, latência e superfície operacional.
- Serverless: escala simples, porém streaming longo e limites do provedor introduzem risco.
- Monólito modular Fastify: baixo overhead, bom suporte a streaming Node e implantação portátil.

## Decisão

Usar Node.js 20+, TypeScript, Fastify, Undici e Vitest em um processo modular único.

## Trade-offs e consequências

O deploy é simples e testável. Cache e rate limit em memória não são globalmente consistentes; escala horizontal futura exigirá armazenamento compartilhado e uma nova ADR.

## Escopo (25/09/2026)

"Gateway stateless… nenhuma persistência" vale para o **Model Plane**. O Agent Plane é um processo separado com persistência mínima de metadados em SQLite ([ADR-022](./ADR-022-agent-plane-nativo.md), [ADR-024](./ADR-024-persistencia-de-sessoes-e-dependencias-do-agent-plane.md)).
