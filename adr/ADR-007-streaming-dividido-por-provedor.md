# ADR-007 — Streaming dividido por provedor

- Status: aceito
- Fase: reavaliação F2/F3
- Data: 16/07/2026
- Substitui parcialmente: ADR-003

## Contexto

O upstream (DeepSeek por padrão) já oferece SSE confiável que deve permanecer opaco. As CLIs, por outro lado, emitem eventos internos e uma decisão final que só pode chegar ao cliente após validação completa.

## Opções consideradas

- Converter todo provedor para um SSE comum: facilitaria consumidores, mas quebraria a transparência e poderia remover campos futuros do upstream.
- Bufferizar todos os provedores: simplificaria validação, mas degradaria o streaming existente.
- Manter dois regimes explícitos: preserva o upstream e contém a saída experimental das CLIs.

## Decisão

O upstream continua com passthrough byte a byte. Para aliases CLI, o gateway envia heartbeat SSE a cada intervalo configurado enquanto aguarda, valida a decisão inteira e então emite conteúdo ou tool calls atomicamente, usage quando disponível e `[DONE]`.

Se uma falha ocorrer antes do primeiro heartbeat, o gateway ainda pode responder com o status HTTP apropriado. Depois de o stream começar, envia um evento `error` sanitizado e encerra sem `[DONE]`. Não há retry de solicitações CLI.

## Trade-offs e consequências

O usuário recebe sinal de vida, mas não tokens incrementais do CLI. A resposta CLI usa memória limitada até o máximo configurado. O contrato e os testes precisam distinguir explicitamente os dois regimes.
