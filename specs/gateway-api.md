# Especificação funcional do azigate

## Rotas

| Método | Caminho | Autenticação | Resultado |
|---|---|---|---|
| GET | `/health` | não | liveness local |
| GET | `/ready` | não | readiness de ao menos um provider |
| GET | `/v1/models` | Bearer gateway | catálogo combinado e filtrado |
| POST | `/v1/chat/completions` | Bearer gateway | JSON ou SSE conforme provider |

Qualquer outro caminho recebe `404`. Nenhum parâmetro público representa URL, host, path, comando, cwd ou ambiente upstream.

## Roteamento por modelo

| `model` | Provider | Comportamento |
|---|---|---|
| `codex-cli-sol` | Codex (Responses API) | `gpt-5.6-sol` |
| `codex-cli-terra` | Codex (Responses API) | `gpt-5.6-terra` |
| `codex-cli-luna` | Codex (Responses API) | `gpt-5.6-luna` |
| `codex-cli-5.5` | Codex (Responses API) | `gpt-5.5` |
| `codex-cli-5.4` | Codex (Responses API) | `gpt-5.4` |
| `codex-cli` | Codex (Responses API) | sinônimo legado de `gpt-5.4` |
| `claude-cli-opus-5.5` | Claude (Messages API) | `claude-opus-5-5` |
| `claude-cli-opus-5` | Claude (Messages API) | `claude-opus-5` |
| `claude-cli-fable-5.1` | Claude (Messages API) | `claude-fable-5-1` |
| `claude-cli-sonnet-5` | Claude (Messages API) | `claude-sonnet-5` |
| `claude-cli-haiku-4.5` | Claude (Messages API) | `claude-haiku-4-5` |
| `claude-cli` | Claude (Messages API) | sinônimo de `claude-opus-5-5` |
| qualquer outro ID permitido | upstream (DeepSeek por padrão) | passthrough atual |

Alias desabilitado ou sem token OAuth salvo retorna `503 cli_unavailable`; nunca há fallback automático. Os prefixos `codex-cli` e `claude-cli` são reservados: um ID com esses prefixos fora da tabela (por exemplo, um alias removido como `claude-cli-opus-4.8`) recebe `400 invalid_model` e nunca segue para o upstream ([ADR-021](../adr/ADR-021-catalogo-claude-geracao-5.md)). `ALLOWED_MODELS`, quando preenchida, também precisa incluir os aliases desejados.

## Catálogo

`GET /v1/models` consulta o upstream e a presença do token OAuth de cada alias. A resposta bem-sucedida sempre usa `{ "object": "list", "data": [...] }`:

- modelos do upstream mantêm os metadados seguros retornados por ele;
- aliases locais usam `object: model`, `created: 0` e `owned_by: codex-cli|claude-cli`;
- falha parcial ainda retorna os providers saudáveis;
- nenhum provider utilizável retorna `503 providers_unavailable`.

## Chat do upstream (passthrough)

- `Content-Type` JSON, `model` string e `messages` array são obrigatórios.
- Campos desconhecidos são aceitos e encaminhados de forma opaca.
- `stream: true` preserva SSE byte a byte.
- Status/corpos seguros do upstream são preservados na rota de chat.

## Chat CLI (Codex/Claude via HTTP nativo)

- Mensagens aceitam texto e conteúdo multimodal (imagem, documento, áudio conforme o provedor); tudo é traduzido para o formato nativo (ver [camada de tradução](../docs/modules/translation/index.md)).
- Tools devem ser `type: function` (ou, para Claude, ferramentas nativas do provedor passadas de forma opaca), com nomes únicos válidos e parameters em objeto.
- `parameters` omitido ou vazio é normalizado para `{}`. Tool calls históricas são
  validadas estruturalmente, mas não precisam continuar na allowlist do turno atual;
  somente novas tool calls produzidas pelo modelo ficam restritas às tools atuais.
- `tool_choice` aceita `auto`, `none`, `required` ou uma função oferecida. Em `claude-cli-opus-5.5`, `claude-cli` e `claude-cli-fable-5.1`, cuja API recusa escolha forçada, `required` e função nomeada são enviados como `auto`: o modelo pode responder sem chamar ferramenta.
- `parallel_tool_calls` deve ser boolean.
- Para aliases Codex e Claude, o effort pode vir como `reasoning_effort` ou `reasoning.effort`; o campo plano tem precedência. A enum pública é `low`, `medium`, `high`, `xhigh` ou `max`. Estrutura ou valor desconhecido recebe `400 invalid_reasoning_effort`.
- Ausência, `reasoning: false` ou objeto `reasoning` sem `effort` aplica o default do modelo. Codex usa `medium`; `max` vira `xhigh`. A matriz Claude permanece por modelo: default `medium` no Opus 5.5, `high` no Opus 5, Fable 5.1 e Sonnet 5; Haiku 4.5 nunca recebe effort.
- O gateway ignora parâmetros de sampling não aplicáveis ao provedor (ex.: `temperature`/`top_p` quando `thinking` está ativo no Claude; nenhum parâmetro de sampling é enviado ao Codex).
- Cada alias Codex é traduzido pelo gateway para um único modelo interno permitido, enviado como `model` no corpo da Responses API. O cliente não escolhe esse valor.
- Cada alias Claude seleciona um único modelo completo enviado como `model` no corpo da Messages API.
- A saída contém texto ou tool calls, nunca ambos. Nome/argumentos são validados; IDs de tool call vêm do provedor (`tool_use.id`/`call_id`).
- Sem limite fixo de tamanho de transcript: o corpo HTTP geral (`MAX_REQUEST_BODY_BYTES`) e os limites do próprio provedor se aplicam.

## Streaming CLI

Streaming incremental real: cada evento SSE nativo do provedor (Anthropic ou
Responses) é traduzido e repassado como chunk `chat.completion.chunk` assim que
chega, sem heartbeat nem buffer da resposta inteira. A sequência típica é:

1. chunks incrementais de `content`/`tool_calls`/`reasoning_content`;
2. chunk com `finish_reason`;
3. chunk de usage quando disponível;
4. `data: [DONE]`.

Falha antes do primeiro byte mantém o status HTTP do erro. Falha depois do
início do stream envia `event: error` com corpo sanitizado e encerra sem `[DONE]`.

Sem `stream: true`, a resposta é um `chat.completion` único acumulado a partir
dos mesmos chunks. O gateway negocia SSE com o provedor nos dois casos: o
`stream` do cliente não altera o formato pedido à Messages API ou à Responses
API (ADR-019).

## Erros locais

| Status | Código | Condição |
|---|---|---|
| 400 | `invalid_json`, `invalid_request`, `invalid_model`, `invalid_messages` | JSON/campos mínimos inválidos; `invalid_model` também para alias CLI desconhecido |
| 400 | `invalid_reasoning_effort` | `reasoning_effort`/`reasoning.effort` inválido para aliases CLI |
| 401 | `invalid_gateway_key` | Bearer ausente/inválido |
| 403 | `ip_not_allowed`, `model_not_allowed` | allowlist |
| 413 | `request_body_too_large` | corpo HTTP acima do limite |
| 415 | `unsupported_media_type` | Content-Type incompatível |
| 429 | `rate_limit_exceeded` | limite HTTP local |
| 502 | `upstream_connection_error`, `upstream_protocol_error` | upstream inválido/inacessível |
| status do provedor | `codex_upstream_error`, `anthropic_upstream_error` | erro retornado pelo provedor Codex/Claude; o status recebido é preservado quando está entre 400 e 599, senão vira 502 |
| 502 | `codex_connection_error`, `anthropic_connection_error` | falha de conexão com o provedor |
| 502 | `oauth_token_exchange_failed`, `oauth_refresh_failed` | falha no fluxo OAuth do provedor |
| 503 | `cli_unavailable` | alias desabilitado ou sem token OAuth salvo |
| 503 | `providers_unavailable` | catálogo sem nenhum provider utilizável |
| 503 | `oauth_not_logged_in` | token OAuth ausente para o provedor solicitado |
| 504 | `upstream_timeout`, `codex_timeout`, `anthropic_timeout` | timeout do provider |
| 500 | `internal_error` | falha inesperada sanitizada |

### Cabeçalho `retry-after`

Quando o provedor Codex/Claude responde com `retry-after`, o gateway normaliza o valor
para segundos inteiros e o devolve no mesmo cabeçalho junto do erro sanitizado. Valor
ausente ou inválido é descartado — o gateway nunca repassa o texto recebido como veio.
O `429` local (`rate_limit_exceeded`) continua usando o `retry-after` calculado pelo
próprio limitador.
