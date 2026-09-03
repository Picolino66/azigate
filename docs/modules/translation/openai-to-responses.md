# OpenAI → Responses/Codex (requisição)

## Descrição

Converte um `ChatBody` OpenAI Chat Completions no corpo da Responses API usada
pelo Codex (`chatgpt.com/backend-api/codex/responses`).

## Localização no código

`src/translation/openai-to-responses.ts`, função `translateOpenAiToResponses`,
mais `buildShortNameMap`.

## Entrada

`ChatBody` (model, messages, tools, tool_choice, response_format,
parallel_tool_calls) mais `{ model, effort? }`. O `stream` do cliente não é
entrada desta tradução: ele governa apenas a borda de saída do gateway.

## Saída

`TranslatedResponsesRequest`: `{ request: ResponsesRequestBody, shortNames:
ShortNameMapping }`. O corpo tem campos fixos: `instructions: ""`, `store: false`,
`stream: true`, `reasoning: {effort, summary:"auto"}`,
`include: ["reasoning.encrypted_content"]`, mais `prompt_cache_key` quando há
âncora de conversa.

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
- `prompt_cache_key` é `azigate-<sha256 truncado em 32 hex>` sobre a quantidade e
  os nomes das ferramentas mais a **âncora da conversa**: o texto da primeira
  mensagem `user` não vazia (`buildPromptCacheKey`). A âncora não muda entre
  turnos, então a chave permanece estável durante toda a conversa e serve como
  dica de roteamento para o cache de prefixo do fornecedor (ADR-020).
- Mensagens `system` ficam fora da âncora de propósito: agentes injetam nelas
  conteúdo volátil (data, cwd, arquivos abertos), que rotacionaria a chave a cada
  turno.
- Sem mensagem `user` com texto, `prompt_cache_key` é omitido em vez de assumir
  valor degenerado. A chave nunca é registrada em log.

## Fluxo resumido

Construir `shortNames` a partir de todos os nomes de tool -> converter mensagens
para `input[]` -> converter tools/tool_choice/response_format aplicando os nomes
encurtados -> montar o corpo com os campos fixos da Responses API.

## Possíveis erros

Nenhum — a função nunca lança; conteúdo não reconhecido é omitido do `input[]`
(ex.: parte de conteúdo com `type` desconhecido).
