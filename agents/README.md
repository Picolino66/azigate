# Ownership de agentes

- Orquestrador principal: arquitetura, integração, implementação, rastreabilidade e quality gates.
- Especialista de arquitetura/refatoração: fronteiras provider/broker e preservação do adaptador DeepSeek.
- Auditor defensivo: threat model, isolamento do broker, secrets, API, containers e revisão final; não altera produção.
- Especialista docs-first: sincroniza docs, contratos, ADRs e índices depois das decisões consolidadas.
- Pesquisa oficial: contratos do Codex CLI, Claude CLI, Qwen Code, DeepSeek e Nginx, sem escrita concorrente.

Trabalhos especialistas recebem o `OrchestratorContext` atualizado e retornam evidências ao orquestrador, que resolve conflitos antes de registrar decisões. O Qwen Code no PC da VPN é o único executor de ferramentas do fluxo de produto; isso não deve ser confundido com agentes usados no desenvolvimento do gateway.

## Ciclo `native-agent-plane` (25/09/2026)

- Orquestrador principal: ADR-022 a ADR-024, contratos do Agent Plane, implementação, gates e contexto canônico.
- Auditor defensivo: fronteiras novas (agentd, worker, ponte MCP), jail de workspace, Git endurecido, credenciais disjuntas e revisão final.
- Especialista docs-first: `docs/modules/agents/`, runbook, arquitetura, threat model, inventário e índices.

No Agent Plane o executor de ferramentas é o **agente nativo** (Codex, Claude Code ou AGY) confinado ao workspace escolhido por ID; no Model Plane continua sendo o agente cliente. Não confundir nenhum dos dois com os agentes usados no desenvolvimento do gateway.
