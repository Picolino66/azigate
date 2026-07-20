# ADR-014 — Sessões CLI efêmeras em memória e usage por provider

## Status

Aceita em 20/07/2026. Evolui o broker para o protocolo v6 e complementa os
ADR-005, ADR-008, ADR-010 e ADR-011. O snapshot O5 permanece como último estável
até o deploy coordenado e o benchmark real.

## Contexto

O broker executava `codex exec` e `claude --print` em um processo novo por request.
Cada request recebia novamente instruções, catálogo de tools e transcript completo.
Além de reduzir o reaproveitamento de prompt cache, a telemetria Claude registrava
somente `input_tokens` e descartava `cache_creation_input_tokens` e
`cache_read_input_tokens`. Assim, o log mostrava um input irrealisticamente baixo e
não permitia explicar o consumo observado na cota.

No Codex, `cached_input_tokens` já é subconjunto de `input_tokens`; no Claude, os
três campos de entrada são parcelas distintas. Uma regra única produziria dupla
contagem em um provider ou subcontagem no outro.

## Alternativas consideradas

1. Continuar stateless e apenas corrigir logs: baixo risco, mas não reduz reenvio.
2. Persistir IDs/transcripts em banco ou disco: permite retomada após restart, mas
   amplia a fronteira de dados sensíveis e contradiz o uso pessoal sem storage.
3. Manter sessões somente em RAM, correlacionadas por hashes semânticos, usando
   interfaces multi-turn oficiais dos CLIs.

## Decisão

- O gateway HTTP permanece stateless. Somente o broker guarda sessões temporárias
  em RAM, com TTL, LRU e limite global.
- Codex usa um `codex app-server` privado, threads `ephemeral: true`, `turn/start`,
  `outputSchema` e `tokenUsage.last`.
- Claude usa um processo `--print` persistente com input/output `stream-json` e
  `--no-session-persistence`.
- A correlação usa SHA-256 de mensagens e prompt estável. IDs de tool calls são
  normalizados antes do hash. Reuso exige um único prefixo exato; qualquer
  ambiguidade, divergência, troca de modelo ou troca de effort Claude cria sessão.
- O primeiro turno envia o transcript completo. Turnos seguintes enviam somente o
  delta posterior ao prefixo confirmado. Nenhum transcript ou hash é persistido.
- Usage é interpretado separadamente:
  - Claude: `prompt = input + cache_creation + cache_read`;
  - Codex: `prompt = input`, `fresh = input - cached`;
  - reasoning e cached nunca são somados novamente ao total.
- O protocolo v6 transporta os detalhes de cache apenas para logs/métricas. A
  resposta pública conserva `prompt_tokens`, `completion_tokens` e `total_tokens`.
- Transcripts acima de 256 KiB recebem `413 cli_context_too_large`, sem truncamento.

## Trade-offs

O primeiro turno continua caro e reinício/TTL/eviction perdem o cache conversacional.
Processos persistentes consomem mais RAM e exigem tratamento cuidadoso de crash e
cancelamento. Em troca, não há banco nem transcript em disco, o prefixo estável pode
ser cacheado e turnos seguintes evitam reenviar o histórico ao processo.

`totalTokens` representa volume lógico processado, não a porcentagem da cota. Planos
Claude/Codex aplicam pesos que não fazem parte do contrato do gateway.

## Consequências

- Broker e gateway precisam ser implantados juntos por causa do protocolo v6.
- O modo `stateless` permanece como contingência explícita por provider.
- Gates automatizados usam processos falsos; smokes reais e benchmark de dez turnos
  continuam manuais para não consumir cota durante CI.
- DeepSeek e o passthrough HTTP/SSE não mudam.
