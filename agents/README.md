# Ownership de agentes

- Orquestrador principal: arquitetura, merge, implementação e quality gates.
- Pesquisa Cline: contrato do cliente OpenAI Compatible, sem escrita no repositório.
- Pesquisa DeepSeek: contrato upstream oficial, sem escrita no repositório.
- Pesquisa Nginx: recomendações oficiais de proxy/TLS/SSE, sem escrita no repositório.
- Auditor defensivo: threat model e revisão final complementar; não altera produção.

Agentes de pesquisa recebem snapshot imutável do contexto e retornam evidências ao orquestrador, que resolve conflitos antes de registrar decisões.

