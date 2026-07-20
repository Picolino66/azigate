# Especificação funcional do gateway-ai

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
| `codex-cli-sol` | broker/Codex | `gpt-5.6-sol` |
| `codex-cli-terra` | broker/Codex | `gpt-5.6-terra` |
| `codex-cli-luna` | broker/Codex | `gpt-5.6-luna` |
| `codex-cli-5.5` | broker/Codex | `gpt-5.5` |
| `codex-cli-5.4` | broker/Codex | `gpt-5.4` |
| `codex-cli` | broker/Codex | sinônimo legado de `gpt-5.4` |
| `claude-cli-fable-5` | broker/Claude | `claude-fable-5` |
| `claude-cli-sonnet-5` | broker/Claude | `claude-sonnet-5` |
| `claude-cli-opus-4.8` | broker/Claude | `claude-opus-4-8` |
| `claude-cli-opus-4.7` | broker/Claude | `claude-opus-4-7` |
| `claude-cli-opus-4.6` | broker/Claude | `claude-opus-4-6` |
| `claude-cli-sonnet-4.6` | broker/Claude | `claude-sonnet-4-6` |
| `claude-cli-sonnet-4.5` | broker/Claude | `claude-sonnet-4-5` |
| `claude-cli-haiku-4.5` | broker/Claude | `claude-haiku-4-5` |
| `claude-cli` | broker/Claude | sinônimo legado de `claude-sonnet-4-6` |
| qualquer outro ID permitido | upstream (DeepSeek por padrão) | passthrough atual |

Alias desabilitado retorna `503 cli_unavailable`; nunca há fallback automático. `ALLOWED_MODELS`, quando preenchida, também precisa incluir os aliases desejados.

## Catálogo

`GET /v1/models` consulta o upstream e o health do broker. A resposta bem-sucedida sempre usa `{ "object": "list", "data": [...] }`:

- modelos do upstream mantêm os metadados seguros retornados por ele;
- aliases locais usam `object: model`, `created: 0` e `owned_by: codex-cli|claude-cli`;
- falha parcial ainda retorna os providers saudáveis;
- nenhum provider utilizável retorna `503 providers_unavailable`.

## Chat do upstream (passthrough)

- `Content-Type` JSON, `model` string e `messages` array são obrigatórios.
- Campos desconhecidos são aceitos e encaminhados de forma opaca.
- `stream: true` preserva SSE byte a byte.
- Status/corpos seguros do upstream são preservados na rota de chat.

## Chat CLI

- Mensagens devem conter somente texto. Arrays de content aceitam exclusivamente blocos `{ "type": "text", "text": "..." }`.
- Tools devem ser `type: function`, ter nomes únicos válidos e parameters em objeto.
- `tool_choice` aceita `auto`, `none`, `required` ou uma função oferecida.
- `parallel_tool_calls` deve ser boolean.
- Para aliases Claude, `reasoning_effort` aceita somente `low`, `medium`, `high`, `xhigh` ou `max`. Valor omitido ou incompatível é substituído pelo padrão do modelo. Sonnet 4.5 e Haiku 4.5 nunca recebem effort.
- Conteúdo multimodal recebe `400 invalid_cli_request`.
- O gateway ignora parâmetros de sampling não aplicáveis e nunca os converte em argv.
- Cada alias Codex é traduzido pelo gateway para um único modelo interno permitido; o cliente não escolhe `--model` nem qualquer outro argumento CLI.
- Cada alias Claude seleciona um único modelo completo por `--model`; modelo e effort são validados novamente pelo broker. Thinking não é publicado.
- A saída contém texto ou tool calls, nunca ambos. Nome/argumentos são validados e os IDs são gerados localmente.

## Streaming CLI

Enquanto a decisão está pendente, o gateway envia `: keep-alive` a cada `CLI_HEARTBEAT_INTERVAL_MS`. Depois da validação envia:

1. chunk atômico com content ou tool calls;
2. chunk com `finish_reason`;
3. chunk de usage quando disponível;
4. `data: [DONE]`.

Falha antes do primeiro byte mantém o status HTTP do erro. Falha depois do heartbeat envia `event: error` com corpo sanitizado e encerra sem `[DONE]`.

## Erros locais

| Status | Código | Condição |
|---|---|---|
| 400 | `invalid_json`, `invalid_request`, `invalid_model`, `invalid_messages` | JSON/campos mínimos inválidos |
| 400 | `invalid_cli_request` | conteúdo/tool contract não suportado pelo CLI |
| 401 | `invalid_gateway_key` | Bearer ausente/inválido |
| 403 | `ip_not_allowed`, `model_not_allowed` | allowlist |
| 413 | `request_body_too_large` | corpo acima do limite |
| 415 | `unsupported_media_type` | Content-Type incompatível |
| 429 | `rate_limit_exceeded` | limite HTTP local |
| 429 | `cli_busy` | broker ocupado, sem fila |
| 502 | `upstream_connection_error`, `upstream_protocol_error` | upstream inválido/inacessível |
| 502 | `invalid_cli_output`, `cli_execution_failed` | saída CLI recusada/falha de processo |
| 503 | `cli_unavailable` | alias, login, binário ou capacidade indisponível |
| 503 | `providers_unavailable` | catálogo sem nenhum provider utilizável |
| 504 | `upstream_timeout`, `cli_timeout` | timeout do provider |
| 500 | `internal_error` | falha inesperada sanitizada |

## Protocolo privado

O contrato Unix socket está em [broker-api.md](./broker-api.md). Ele não amplia a superfície HTTP pública.
