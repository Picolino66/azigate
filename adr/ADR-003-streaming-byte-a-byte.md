# ADR-003 — Streaming byte a byte e cancelamento propagado

- Status: aceito, parcialmente substituído pelo ADR-007
- Fase: F2/F3
- Data: 14/07/2026

## Contexto

Clientes OpenAI Compatible, incluindo o Qwen Code, dependem de deltas SSE, tool calls fragmentadas, usage final, keep-alive e `[DONE]`.

## Opções consideradas

- Bufferizar e reserializar: facilita métricas, mas quebra latência e pode alterar eventos.
- Copiar bytes e observar passivamente: mantém transparência com métricas limitadas.

## Decisão

Copiar cada chunk upstream imediatamente para a resposta. Um observador separado pode extrair somente usage, sem atrasar ou modificar bytes. O fechamento do cliente aborta o fetch upstream; não há retry após o primeiro byte enviado.

## Trade-offs e consequências

Erros após início do stream não podem mudar o status HTTP. A configuração Nginx desativa buffering, cache e gzip.

## Reavaliação de 16/07/2026

O ADR-007 substitui esta decisão somente para provedores CLI, cuja saída precisa ser validada integralmente antes de ser publicada. O passthrough byte a byte, o observador passivo de usage e o cancelamento descritos aqui permanecem inalterados para a DeepSeek.
