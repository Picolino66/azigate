# OpenAI → Responses/Codex (requisição)

## Descrição

Converte um `ChatBody` OpenAI Chat Completions no corpo da Responses API usada
pelo Codex (`chatgpt.com/backend-api/codex/responses`).

## Localização no código

`src/translation/openai-to-responses.ts`, função `translateOpenAiToResponses`,
mais `buildShortNameMap`.

## Entrada

`ChatBody` (model, messages, tools, tool_choice, stream, response_format,
parallel_tool_calls) mais `{ model, effort? }`.

## Saída

`TranslatedResponsesRequest`: `{ request: ResponsesRequestBody, shortNames:
ShortNameMapping }`. O corpo tem campos fixos: `instructions: ""`, `store: false`,
`reasoning: {effort, summary:"auto"}`, `include: ["reasoning.encrypted_content"]`.

## Dependências

Nenhuma (função pura).

## Regras de negócio

| Origem | Destino em `input[]` |
| --- | --- |
| `role:"system"` | item `{type:"message",role:"developer"}` |
| `role:"user"` texto/multimodal | `content:[{type:"input_text"/"input_image"/"input_file"/"input_audio"}]` |
| `role:"assistant"` texto | `content:[{type:"output_text",text}]` |
| `assistant.tool_calls[]` | itens de topo `{type:"function_call",call_id,name,arguments}` |
| `role:"tool"` | item de topo `{type:"function_call_output",call_id,output}` |
| `tools[].function` | `{type:"function",name,description,parameters,strict}` achatado |
| `response_format.json_schema` | `text.format` (`type`,`name`,`strict`,`schema`) |
| `tool_choice` | `auto`/`required`/`none` passthrough; função nomeada → `{type:function,name}` achatado |

Regras adicionais:

- **Nunca envia** `temperature`, `top_p` ou `max_output_tokens` — a Responses via
  Codex rejeita esses campos.
- Mensagem de assistant que contém **apenas** `tool_calls` não vira item
  `message`; os `function_call` são emitidos diretamente, preservando a
  correlação por `call_id`.
- `parallel_tool_calls` só é enviado quando há `tools` no corpo.
- Nomes de ferramenta acima de 64 caracteres são encurtados preservando o prefixo
  `mcp__` e o último segmento (`buildShortNameMap`), com colisões resolvidas por
  sufixo numérico; o mapa reverso é usado por `responses-to-openai.ts` para
  devolver o nome original ao cliente.

## Fluxo resumido

Construir `shortNames` a partir de todos os nomes de tool -> converter mensagens
para `input[]` -> converter tools/tool_choice/response_format aplicando os nomes
encurtados -> montar o corpo com os campos fixos da Responses API.

## Possíveis erros

Nenhum — a função nunca lança; conteúdo não reconhecido é omitido do `input[]`
(ex.: parte de conteúdo com `type` desconhecido).
