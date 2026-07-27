# Anthropic → OpenAI (stream)

## Descrição

Converte cada evento SSE da Messages API da Anthropic em zero ou mais chunks
`chat.completion.chunk` no formato OpenAI, mantendo estado por stream.

## Localização no código

`src/translation/anthropic-to-openai.ts`, função `translateAnthropicEvent`, mais
o guard `isAnthropicStreamEvent`.

## Entrada

Um `AnthropicStreamEvent` desserializado do campo `data:` do SSE, mais o
`StreamState` da requisição em curso (`src/translation/state.ts`).

## Saída

`TranslatedStreamStep`: `{ chunks: OpenAiChunk[], done: boolean, errored?: boolean }`.

## Dependências

`src/translation/state.ts` (helpers `baseChunk`, `roleDelta`, `trackToolCall`).

## Regras de negócio

| Evento Anthropic | Ação |
| --- | --- |
| `message_start` | captura `message.id`, `message.model` e `usage.input_tokens`; nenhum chunk |
| `content_block_start` (`text`) | emite `delta.role:"assistant"` na primeira vez apenas |
| `content_block_start` (`tool_use`) | abre novo índice; emite `delta.tool_calls[{index,id,type:function,function:{name,arguments:""}}]` |
| `content_block_delta` / `text_delta` | `delta.content` |
| `content_block_delta` / `input_json_delta` | `delta.tool_calls[{index,function:{arguments:partial}}]` |
| `content_block_delta` / `thinking_delta` | `delta.reasoning_content` |
| `content_block_stop` | nenhum chunk |
| `message_delta` | `stop_reason`→`finish_reason`; `usage.output_tokens` vira chunk de usage separado |
| `message_stop` | `done: true`, sem chunk |
| `error` | `done: true, errored: true`, sem chunk |

Mapa de `stop_reason`→`finish_reason`: `end_turn`→`stop`, `max_tokens`→`length`,
`tool_use`→`tool_calls`, `stop_sequence`→`stop`, `refusal`→`content_filter`,
desconhecido→`stop`.

## Fluxo resumido

`src/providers/cli-completion.ts` lê o SSE evento a evento
(`src/providers/sse-reader.ts`), valida com `isAnthropicStreamEvent` e chama
`translateAnthropicEvent` para cada um, repassando os chunks incrementalmente ou
acumulando conforme o cliente pediu `stream`.

## Possíveis erros

Nenhum lançado pela função em si; o evento `error` do provedor é sinalizado via
`errored: true` para o driver de streaming decidir como encerrar a resposta ao
cliente (evento `error` sanitizado, sem `[DONE]`).
