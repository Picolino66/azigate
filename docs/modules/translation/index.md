# Camada de tradução

## Descrição

Quatro conversores puros, síncronos e sem I/O que traduzem entre o formato OpenAI
Chat Completions e os formatos nativos da Messages API (Anthropic) e da Responses
API (OpenAI/Codex), nos dois sentidos: corpo de requisição e stream de eventos.
Substitui o antigo "tradutor" implícito — pedir ao próprio modelo CLI que
devolvesse um envelope de decisão — por código determinístico e testável por
tabela (ver [ADR-016](../../../adr/ADR-016-substituicao-do-broker-por-adaptadores-http.md)).

## Localização no código

`src/translation/openai-to-anthropic.ts`, `src/translation/anthropic-to-openai.ts`,
`src/translation/openai-to-responses.ts`, `src/translation/responses-to-openai.ts`
e `src/translation/state.ts` (estado compartilhado por stream: índices de tool
call, id, model, created, mapa de nomes encurtados).

## Entrada

- `openai-to-anthropic.ts` / `openai-to-responses.ts`: o `ChatBody` OpenAI já
  validado pelas camadas de segurança/roteamento, mais o modelo interno e o
  effort já normalizados.
- `anthropic-to-openai.ts` / `responses-to-openai.ts`: um evento SSE já
  desserializado (JSON) do provedor, mais o `StreamState` da requisição em curso.

## Saída

- Requisição: corpo pronto para `JSON.stringify` e envio ao adaptador HTTP.
- Resposta: `{ chunks: OpenAiChunk[], done: boolean, errored?: boolean }` — zero ou
  mais chunks no formato `chat.completion.chunk`, mais sinalização de término/erro
  para o driver de streaming (`src/providers/cli-completion.ts`) decidir entre
  repassar incrementalmente ou acumular em um `chat.completion` único.

## Dependências

Nenhuma — funções puras, sem rede, sem filesystem, sem relógio além de um
parâmetro opcional para testes determinísticos (`createStreamState` aceita
`createdAt` explícito).

## Regras de negócio

Ver os quatro arquivos de feature para a tabela completa de mapeamento:

- [OpenAI → Anthropic (requisição)](./openai-to-anthropic.md)
- [Anthropic → OpenAI (stream)](./anthropic-to-openai.md)
- [OpenAI → Responses/Codex (requisição)](./openai-to-responses.md)
- [Responses/Codex → OpenAI (stream)](./responses-to-openai.md)

## Fluxo resumido

`src/routes/chat.ts` normaliza o alias/effort -> chama o tradutor de requisição do
provedor -> `AnthropicClient`/`CodexClient` envia o corpo e abre o SSE -> o driver
de streaming lê evento a evento com `src/providers/sse-reader.ts` -> chama o
tradutor de resposta do provedor -> emite chunks OpenAI incrementalmente ou os
acumula em um `chat.completion`.

## Possíveis erros

A camada de tradução não lança erros de rede — ela é pura. Entradas malformadas do
provedor (evento SSE com `type` desconhecido) são ignoradas pelo driver de
streaming; falhas de parsing/tradução viram `codex_upstream_error`/
`anthropic_upstream_error` como defesa em profundidade.
