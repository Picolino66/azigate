# Responses/Codex → OpenAI (stream)

## Descrição

Converte cada evento SSE da Responses API (Codex) em zero ou mais chunks
`chat.completion.chunk` no formato OpenAI, mantendo estado por stream.

## Localização no código

`src/translation/responses-to-openai.ts`, função `translateResponsesEvent`, mais
o guard `isResponsesStreamEvent`.

## Entrada

Um `ResponsesStreamEvent` desserializado do campo `data:` do SSE, mais o
`StreamState` da requisição em curso, incluindo o `shortNameMap` para restaurar
nomes de tool encurtados na requisição.

## Saída

`TranslatedStreamStep`: `{ chunks: OpenAiChunk[], done: boolean }`.

## Dependências

`src/translation/state.ts` (helpers `baseChunk`, `roleDelta`, `trackToolCall`,
`originalToolName`).

## Regras de negócio

| Evento | Ação |
| --- | --- |
| `response.created` | captura `id`, `model`, `created_at`; nenhum chunk |
| `response.output_text.delta` | `delta.content` |
| `response.reasoning_summary_text.delta` | `delta.reasoning_content` |
| `response.output_item.added` (`function_call`) | incrementa índice; emite `delta.tool_calls[{index,id:call_id,function:{name}}]` com o nome original restaurado |
| `response.function_call_arguments.delta` | `delta.tool_calls[{index,function:{arguments}}]` |
| `response.function_call_arguments.done` | emite argumentos completos **apenas** se nenhum delta chegou antes |
| `response.output_item.done` | fallback quando o item nunca foi anunciado por `added` |
| `response.completed` | `finish_reason` (`tool_calls` se houve tool call, senão `stop`) + `usage`; `done: true` |
| `response.incomplete` | `finish_reason` por `incomplete_details.reason` (`max_output_tokens`→`length`, `content_filter`→`content_filter`, senão `stop`) + `usage`; `done: true` |

Mapa de `usage`: `input_tokens`→`prompt_tokens`, `output_tokens`→`completion_tokens`,
`total_tokens`→`total_tokens`, `input_tokens_details.cached_tokens`→
`prompt_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`→
`completion_tokens_details.reasoning_tokens`.

## Fluxo resumido

`src/providers/cli-completion.ts` lê o SSE evento a evento
(`src/providers/sse-reader.ts`), valida com `isResponsesStreamEvent` e chama
`translateResponsesEvent` para cada um, repassando os chunks incrementalmente ou
acumulando conforme o cliente pediu `stream`.

## Possíveis erros

Nenhum lançado pela função em si; eventos de tipo desconhecido são ignorados pelo
guard `isResponsesStreamEvent` antes de chegar ao tradutor.
