# Provider Codex CLI

## Descrição

Aliases Codex que falam diretamente com a **Responses API** da OpenAI
(`https://chatgpt.com/backend-api/codex/responses`), autenticados pela assinatura
do operador via OAuth — não por API key. Cada alias escolhe um modelo interno
fixo.

## Localização no código

`src/providers/codex-client.ts`, `src/providers/oauth/codex-oauth.ts`,
`src/providers/oauth/login-codex.ts`, `src/translation/openai-to-responses.ts`,
`src/translation/responses-to-openai.ts` e `src/providers/reasoning-effort.ts`.

## Entrada

Mensagens textuais ou multimodais (imagem, arquivo, áudio), function tools,
`tool_choice` e `parallel_tool_calls`. Os modelos públicos são `codex-cli-sol`,
`codex-cli-terra`, `codex-cli-luna`, `codex-cli-5.5` e `codex-cli-5.4`, mapeados
para `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` e `gpt-5.4`.
`codex-cli` continua como sinônimo de `gpt-5.4`. Effort aceita `reasoning_effort`
ou `reasoning.effort` com `low`, `medium`, `high`, `xhigh` ou `max`.

## Saída

Chat Completion com `content` ou `tool_calls`, em JSON (buffer) ou SSE
incremental real, conforme o `stream` do pedido — que afeta apenas a resposta ao
cliente, nunca o formato pedido à Responses API. IDs de tool call vêm do
`call_id` da Responses API.

## Dependências

Token OAuth da assinatura salvo em `CODEX_TOKEN_FILE` (obtido uma vez com
`npm run login:codex`) e `ENABLE_CODEX_CLI=true`.

## Regras de negócio

- O corpo da Responses API tem campos fixos: `instructions: ""`, `store: false`,
  `reasoning.summary: "auto"` e `include: ["reasoning.encrypted_content"]`.
  `temperature`, `top_p` e `max_output_tokens` nunca são enviados — a Responses
  via Codex rejeita esses campos.
- O modelo chega somente pela allowlist interna (`src/cli-catalog.ts`); o cliente
  nunca escolhe o valor enviado em `model`.
- O default de todos os modelos é `medium`; `max` é reduzido para `xhigh` antes de
  chegar à API (`src/providers/reasoning-effort.ts`).
- `reasoning_effort` plano tem precedência sobre `reasoning.effort`; `reasoning: false`, ausência ou objeto sem `effort` usa o default.
- Mensagem de assistant que contém somente `tool_calls` não vira um item
  `message`: os `function_call` são emitidos diretamente no `input[]`, preservando
  a correlação por `call_id`.
- Nomes de ferramenta acima de 64 caracteres são encurtados preservando o prefixo
  `mcp__` e o último segmento, com mapa reverso aplicado na resposta para devolver
  ao cliente o nome original (`buildShortNameMap`).
- Cada requisição leva `prompt_cache_key` derivada da âncora da conversa, para
  estabilizar o roteamento do cache de prefixo entre turnos (ADR-020). A âncora é o
  primeiro `call_id` do histórico; antes da primeira tool call, cai para o primeiro
  texto de usuário não vazio. O tipo da âncora entra no digest, então um `call_id` e
  um texto idênticos nunca geram a mesma chave.
- Quando o fornecedor responde com `retry-after`, o valor é normalizado para segundos
  inteiros pelo gateway e devolvido ao cliente no cabeçalho `retry-after`. Valor
  inválido é descartado, nunca repassado como veio.
- O retry interno respeita o `retry-after` do fornecedor; em `429` sem esse cabeçalho,
  a espera tem piso de 1s (limitado por `RETRY_MAX_DELAY_MS`) em vez do exponencial
  curto usado nos demais status retryable.
- A negociação com o fornecedor é sempre SSE (`stream: true` no corpo e
  `Accept: text/event-stream`), independentemente do `stream` pedido pelo cliente;
  o `stream` do cliente decide apenas se o gateway repassa chunks incrementais ou
  acumula um `chat.completion` (ADR-019).
- Streaming é incremental real: cada evento SSE (`response.output_text.delta`,
  `response.function_call_arguments.delta`, etc.) vira um chunk OpenAI assim que
  chega, sem heartbeat nem buffer da resposta inteira.
- Erro antes do primeiro byte vira status HTTP (`codex_upstream_error`,
  `codex_timeout`, `codex_connection_error`); erro depois do início do stream vira
  evento `error` sanitizado, sem `[DONE]`.
- Retentativas seguem a mesma política do upstream: só antes do início da
  resposta, limitadas a `429`/`502`/`503`/`504`. O número de tentativas repetidas é
  registrado na telemetria como `retryCount`.
- A telemetria registra a forma do prompt — `promptCacheKey`, `prefixFingerprint`,
  `requestBodyBytes`, `inputItemCount`, `toolCount` e `toolSchemaBytes` — mesmo quando
  a requisição falha antes de o fornecedor reportar `usage`. Ver
  [logs de requisição](../observability/logs.md).

## Fluxo resumido

Gateway normaliza modelo/effort -> traduz o corpo OpenAI para o corpo Responses ->
`CodexClient` injeta o token OAuth e chama a API -> SSE nativo é traduzido evento a
evento -> gateway devolve streaming incremental ou `chat.completion` acumulado.

## Possíveis erros

`invalid_reasoning_effort`, `cli_unavailable`, `oauth_not_logged_in`,
`oauth_refresh_failed`, `codex_upstream_error`, `codex_timeout` e
`codex_connection_error`. A causa de `oauth_refresh_failed` aparece no log em
`oauthRefreshStatus`/`oauthRefreshError` — ver
[Renovação de token OAuth](./oauth-token-renewal.md).
