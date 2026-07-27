# OpenAI → Anthropic (requisição)

## Descrição

Converte um `ChatBody` OpenAI Chat Completions no corpo da Messages API da
Anthropic.

## Localização no código

`src/translation/openai-to-anthropic.ts`, função `translateOpenAiToAnthropic`.

## Entrada

`ChatBody` (model, messages, tools, tool_choice, stream, stop, top_p,
temperature, parallel_tool_calls) mais `{ model, defaultMaxTokens, effort?,
thinkingBudgetTokens? }`.

## Saída

`AnthropicRequestBody`: `{ model, messages, max_tokens, system?, stream?, top_p?,
temperature?, stop_sequences?, tools?, tool_choice?, thinking?, output_config? }`.

## Dependências

Nenhuma (função pura).

## Regras de negócio

| Origem (OpenAI) | Destino (Anthropic) |
| --- | --- |
| `messages[role=system].content` | blocos em `system[]` |
| `content` string em user/assistant | `content: [{type:"text",text}]` |
| `content[].image_url.url` com `data:` | bloco `image` base64 |
| `content[].image_url.url` com `http` | bloco `image` url |
| `content[].file.file_data` com `data:` | bloco `document` base64 |
| `assistant.tool_calls[]` | blocos `tool_use` no mesmo `content` |
| `role:"tool"` + `tool_call_id` | mensagem `user` com bloco `tool_result` |
| `stop` (string ou array) | `stop_sequences` (sempre array) |
| `tools[].function` | `tools[]` como `{name,description,input_schema}` |
| `tool_choice` | `auto`→`{type:auto}`, `required`→`{type:any}`, `none`→`{type:none}`, função nomeada→`{type:tool,name}` |
| `effort` | `thinking:{type:adaptive}` + `output_config.effort`, ou `{type:enabled,budget_tokens}` quando uma tabela de budget é fornecida |

Regras adicionais:

- `max_tokens` é obrigatório; usa `body.max_tokens` quando válido, senão
  `defaultMaxTokens`.
- `tool_calls[].function.arguments` (string JSON) é convertido para objeto; se o
  parse falhar ou não for objeto, usa `{}`.
- IDs de tool call são sanitizados para o formato `toolu_`+hex; se ausentes ou
  inválidos, um novo ID é gerado e reaproveitado no `tool_result` correspondente.
- `temperature`/`top_p` são omitidos quando `thinking` está ativo.
- Mensagens `tool` consecutivas são agrupadas em uma única mensagem `user` com
  múltiplos blocos `tool_result`.
- Se o resultado ficar sem nenhuma mensagem, injeta um turno de usuário mínimo
  (a API recusa `messages` vazio).
- Ferramentas nativas não-`function` (ex.: `web_search_*`) são preservadas de
  forma opaca, com `allowed_domains`/`blocked_domains` vazios removidos.

## Fluxo resumido

Converter mensagens (system/user/assistant/tool) -> converter tools/tool_choice ->
converter stop/top_p/temperature -> resolver thinking/effort -> montar o corpo
final com `max_tokens` garantido.

## Possíveis erros

Nenhum — a função nunca lança; entradas inesperadas caem em defaults seguros
(texto vazio, `{}`, `undefined` omitido do corpo).
