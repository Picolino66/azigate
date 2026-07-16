# ADR-002 — Upstream fixo e contrato opaco

- Status: aceito
- Fase: F2/F3
- Data: 14/07/2026

## Contexto

O gateway deve acompanhar campos novos da API sem virar um proxy aberto.

## Opções consideradas

- DTO fechado: validação forte, mas remove campos futuros e metadados de ferramentas.
- Proxy genérico: transparente, mas vulnerável a SSRF e abuso.
- Rotas fixas com payload opaco: preserva evolução do contrato e limita o destino.

## Decisão

Somente `/models` e `/chat/completions` serão construídos por enumeração interna sobre `DEEPSEEK_BASE_URL`. O chat valida apenas JSON, `model`, `messages`, tamanho e allowlist; todo o restante é encaminhado.

## Trade-offs e consequências

Parâmetros inválidos são decididos pela DeepSeek e seus status são preservados. O cliente nunca escolhe esquema, host, porta ou caminho upstream.

