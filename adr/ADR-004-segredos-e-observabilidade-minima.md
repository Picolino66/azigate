# ADR-004 — Segredos externos e observabilidade sem conteúdo

- Status: aceito
- Fase: F2
- Data: 14/07/2026

## Contexto

Prompts de clientes como o Qwen Code podem conter código-fonte e tool arguments; logs operacionais não podem armazená-los.

## Opções consideradas

- Logs completos: diagnóstico fácil e risco crítico de exposição.
- Logs por metadados: diagnóstico suficiente com menor risco.

## Decisão

Registrar somente request ID, método, path, status, duração, stream, modelo, status upstream, tokens e erro sanitizado. Segredos vêm do ambiente ou de arquivos montados e são redigidos no logger.

## Trade-offs e consequências

Análises de conteúdo exigirão reprodução controlada fora dos logs de produção. Métricas ficam prontas internamente para um adaptador Prometheus futuro, sem criar rota pública adicional.
