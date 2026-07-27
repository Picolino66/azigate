# ADR-017 — Fim do regime sintético de SSE

- Status: aceito
- Fase: migração F5
- Data: 27/07/2026
- Substitui: ADR-007

## Contexto

O ADR-007 introduziu um regime SSE dividido: o upstream (DeepSeek) usa passthrough byte a
byte, e os aliases CLI usam heartbeat a cada 15 segundos seguido de uma decisão bufferizada,
validada e emitida atomicamente. Esse regime existia porque a saída do broker era um envelope
`{content, tool_calls}` completo, produzido de uma vez só ao final da execução da CLI — não
havia evento incremental nativo para repassar.

Com a migração para adaptadores HTTP diretos (ADR-016), tanto a Messages API quanto a Responses
API emitem eventos SSE incrementais nativamente (`content_block_delta`,
`response.output_text.delta`, etc.). Não há mais razão estrutural para bufferizar a resposta
inteira antes de emitir qualquer coisa ao cliente.

## Opções consideradas

- Manter o regime de heartbeat + decisão atômica também para os novos adaptadores,
  tratando o SSE nativo como se fosse um envelope único: descartaria o principal ganho da
  migração (streaming incremental real) sem necessidade, já que o upstream agora garante
  formato SSE estável.
- Converter os três regimes (DeepSeek, Anthropic, Responses) para um único formato
  sintético comum: quebraria a transparência do passthrough DeepSeek já validada pelo ADR-003
  e ADR-007, sem ganho correspondente.
- Adotar streaming incremental real para os três adaptadores, cada um com seu próprio
  tradutor de eventos para chunks OpenAI, preservando o passthrough puro só para o DeepSeek:
  opção escolhida.

## Decisão

Remover o heartbeat e a validação atômica de decisão. `src/translation/anthropic-to-openai.ts`
e `src/translation/responses-to-openai.ts` convertem cada evento SSE recebido do fornecedor em
um ou mais chunks `chat.completion.chunk` no momento em que chegam, reaproveitando o mecanismo
de repasse incremental de [src/upstream/response.ts](../src/upstream/response.ts). O stream
encerra com `data: [DONE]` após o evento terminal do fornecedor
(`message_stop`/`response.completed`/`response.incomplete`).

Erro antes do primeiro byte de resposta continua virando status HTTP. Erro depois do início do
stream continua virando um evento `error` sanitizado, sem `[DONE]` — esse comportamento do
ADR-007 é preservado, só muda o que acontece nos eventos normais entre o início e o erro.

## Trade-offs e consequências

Ganha-se: tokens incrementais reais para o cliente (paridade com o comportamento do upstream
DeepSeek), remoção do atraso artificial de heartbeat, e menor uso de memória por não bufferizar
a resposta inteira antes de emitir.

Perde-se a garantia anterior de "decisão validada atomicamente antes de qualquer emissão" — o
cliente agora pode receber conteúdo parcial de uma resposta que só se revela inválida (por
exemplo, JSON de tool call malformado do fornecedor) em um evento posterior. Os módulos de
tradução precisam tratar esse caso token a token (ex.: `input_json_delta` parcial que nunca
fecha) sem quebrar o parser do cliente; ver armadilhas documentadas na Seção 6.5 de
`migracao.md` e os testes de reconstrução de stream da Fase 1/Fase 8 da migração.

O buffer de leitura de linha SSE precisa ser dimensionado para eventos com imagem em base64
(referência: 50 MB por linha no CLIProxyAPI), ou o leitor line-by-line quebra silenciosamente
em respostas multimodais grandes.
