# Ownership de agentes

- Orquestrador principal: arquitetura, integração, implementação, rastreabilidade e quality gates.
- Especialista de arquitetura/refatoração: fronteiras provider/broker e preservação do adaptador DeepSeek.
- Auditor defensivo: threat model, isolamento do broker, secrets, API, containers e revisão final; não altera produção.
- Especialista docs-first: sincroniza docs, contratos, ADRs e índices depois das decisões consolidadas.
- Pesquisa oficial: contratos do Codex CLI, Claude CLI, Qwen Code, DeepSeek e Nginx, sem escrita concorrente.

Trabalhos especialistas recebem o `OrchestratorContext` atualizado e retornam evidências ao orquestrador, que resolve conflitos antes de registrar decisões. O Qwen Code no PC da VPN é o único executor de ferramentas do fluxo de produto; isso não deve ser confundido com agentes usados no desenvolvimento do gateway.
