# ADR-026 — Catálogo e efforts Codex atualizados

- Status: aceito
- Data: 13/11/2026
- Complementa ADR-008 e substitui a matriz Codex do ADR-011.

## Contexto

O operador forneceu novos modelos Codex e seus níveis de effort. A redução anterior de `max` para `xhigh` impede usar a matriz atual.

## Alternativas

Manter a redução preserva o comportamento antigo, mas oculta o valor solicitado. Aceitar qualquer combinação delega erros ao fornecedor. Validar uma matriz fechada permite seleção explícita e erros locais.

## Decisão

Adicionar aliases versionados para os cinco modelos GPT-6, preservando os aliases existentes. Validar os esforços por modelo conforme a matriz fornecida, com default `medium`, e rejeitar combinações não suportadas. O Agent Plane aceita a enum geral e delega a compatibilidade de modelo à CLI nativa.

## Trade-offs e consequências

Clientes que pediam `max` em GPT-5.4 ou 5.5 devem selecionar outro effort. A elegibilidade e disponibilidade real dos modelos dependem da conta e de validação com o fornecedor; testes locais não a comprovam. Não há fallback entre modelos ou provedores.
