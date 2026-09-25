# Skills usadas

- `autonomous-software-orchestrator`: coordenação, ADRs, rastreabilidade e gates.
- `arch-refactor-engine` (complementar): separação multiprovedor e broker sem regressão do monólito.
- `defensive-security-auditor` (complementar): modelo de ameaças, API, isolamento, subprocessos, secrets, dependências, Docker e systemd.
- `ai-docs-self-healing` (complementar): sincroniza fonte docs-first, contratos, ADRs e índices.
- `task-breakdown-engine` (complementar): plano rastreável de evolução.
- `openai-docs` (referência oficial): valida o modo programático e controles disponíveis no Codex CLI instalado.

O backend Fastify/TypeScript foi implementado pelo fluxo de engenharia do orquestrador, preservando as decisões das skills especialistas e o snapshot O5.

## Ciclo `native-agent-plane` (25/09/2026)

- `autonomous-software-orchestrator` (coordenadora, modo `feature-evolution`): fases F2→F7 do `v2.md`, ADR-022 a ADR-024 e gates.
- `task-breakdown-engine` (complementar, F4): plano rastreável [NA-01..NA-14](../tasks/native-agent-plane-plan.md).
- `defensive-security-auditor` (complementar, F2/F6): threat model do Agent Plane e quatro endurecimentos encontrados na revisão (FIFO, `.git`, expiração de token, retenção de sessões).
- `ai-docs-self-healing` (complementar, F5/F6): módulo `docs/modules/agents/`, specs, runbook, índices e `CLAUDE.md`/`AGENTS.md`.
