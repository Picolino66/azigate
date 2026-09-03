# ADR-019 — Adaptadores CLI sempre consomem SSE upstream

- Status: aceito
- Fase: F7 (correção operacional)
- Data: 01/09/2026
- Relaciona-se com: ADR-016, ADR-017

## Contexto

O ADR-017 estabeleceu que os adaptadores CLI convertem eventos SSE do fornecedor em chunks
`chat.completion.chunk`, e que uma requisição sem `stream` é devolvida ao cliente como
`chat.completion` acumulado por `accumulateCompletion`. O leitor de eventos
(`src/providers/sse-reader.ts`) é usado incondicionalmente em `runProviderCompletion`: o modo
não-streaming difere apenas no destino dos chunks, nunca no formato lido do fornecedor.

A implementação, porém, repassava o `stream` do cliente para o fornecedor
(`stream: body.stream` nas duas traduções) e negociava `Accept: application/json` quando o
cliente não pedia streaming. Isso contradizia o próprio parser.

Os logs de operação de 01/09/2026 tornaram a divergência observável: das 187 requisições
`POST /v1/chat/completions` da sessão, as 180 com `stream:true` retornaram `200` e as 7 com
`stream:false` retornaram `400` (`ProviderUpstreamError`) — correlação de 100%. O backend OAuth
do Codex (`https://chatgpt.com/backend-api/codex`) rejeita `stream: false`. No caminho Claude a
mesma divergência não gerava erro visível: a Messages API respondia JSON, o leitor SSE não
encontrava evento algum e o cliente recebia um `chat.completion` vazio com status `200`.

## Opções consideradas

- Repassar `stream` do cliente e ramificar o parser entre SSE e JSON conforme o modo:
  duplicaria a lógica de tradução (um caminho por formato e por fornecedor), aumentaria a
  superfície de teste e reintroduziria um formato de resposta que o backend do Codex sequer
  aceita.
- Recusar requisições não-streaming nos aliases CLI com erro de contrato: quebraria o
  passthrough OpenAI-compatible para clientes que legitimamente não usam streaming, sem
  necessidade, já que a bufferização local já existe e é testada.
- Sempre negociar SSE com o fornecedor e decidir o formato apenas na borda voltada ao cliente:
  opção escolhida.

## Decisão

`translateOpenAiToResponses` e `translateOpenAiToAnthropic` emitem `stream: true` fixo — o
campo deixa de ser opcional no tipo de requisição de ambos os adaptadores. `src/routes/chat.ts`
chama `codexClient.request` e `anthropicClient.request` com `stream: true`, de modo que o
`Accept` negociado é sempre `text/event-stream`.

O `stream` pedido pelo cliente passa a governar exclusivamente a borda de saída, via
`wantsStream` em `runProviderCompletion`: emissão incremental com `data: [DONE]` quando
verdadeiro, `chat.completion` acumulado por `accumulateCompletion` quando falso.

O passthrough do upstream OpenAI-compatible (DeepSeek) permanece intocado: ele continua
recebendo o `stream` do cliente sem alteração, conforme ADR-002 e ADR-003.

## Trade-offs e consequências

Ganha-se: o modo não-streaming volta a funcionar nos dois aliases CLI; some a classe de erro
`400` observada em produção; e a resposta vazia silenciosa do caminho Claude deixa de existir.
O tipo `stream: true` obrigatório impede que a regressão retorne por descuido — omitir o campo
passa a ser erro de compilação.

Perde-se a possibilidade de o cliente influenciar o formato de transporte usado com o
fornecedor. Isso é intencional: o formato de transporte upstream passa a ser decisão interna do
gateway, não entrada do cliente, coerente com a invariante de que o cliente não controla como o
gateway fala com o fornecedor.

Uma requisição não-streaming passa a consumir o stream inteiro em memória antes de responder,
que já era o comportamento efetivo de `accumulateCompletion`; o dimensionamento do buffer de
linha SSE anotado no ADR-017 continua valendo.
