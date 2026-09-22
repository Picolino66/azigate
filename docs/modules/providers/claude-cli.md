# Provider Claude CLI

## Descrição

Aliases Claude que falam diretamente com a **Messages API** da Anthropic
(`https://api.anthropic.com/v1/messages`), autenticados pela assinatura do
operador via OAuth — não por API key. Oito modelos versionados mais o sinônimo
legado `claude-cli`.

## Localização no código

`src/providers/anthropic-client.ts`, `src/providers/oauth/claude-oauth.ts`,
`src/providers/oauth/login-claude.ts`, `src/translation/openai-to-anthropic.ts`,
`src/translation/anthropic-to-openai.ts` e `src/providers/reasoning-effort.ts`.

## Entrada

Mensagens textuais ou multimodais (imagem, documento), function tools,
`tool_choice` e `parallel_tool_calls`. O campo público `model` seleciona apenas um
alias fechado; `reasoning_effort` ou `reasoning.effort` aceita `low`, `medium`,
`high`, `xhigh` ou `max`.

## Saída

Chat Completion com `content`/`tool_calls`, em JSON (buffer) ou SSE incremental
real, conforme o `stream` do pedido — que afeta apenas a resposta ao cliente,
nunca o formato pedido à Messages API.

## Dependências

Token OAuth da assinatura salvo em `CLAUDE_TOKEN_FILE` (obtido uma vez com
`npm run login:claude`) e `ENABLE_CLAUDE_CLI=true`.

## Regras de negócio

- `max_tokens` é obrigatório na Messages API; o gateway aplica um default fixo
  quando o cliente não o envia.
- Cada alias mapeia para um único `model` completo enviado à API;
  `claude-cli` equivale a Sonnet 4.6.
- Omissão ou effort incompatível aplica o padrão do catálogo. Sonnet 4.5 e
  Haiku 4.5 nunca recebem `thinking`. Quando `thinking` está ativo, `temperature`
  e `top_p` são omitidos (a API rejeita a combinação em alguns modelos).
- O formato plano (`reasoning_effort`) tem precedência sobre o aninhado
  (`reasoning.effort`); `reasoning: false` usa o default do modelo.
- Ferramentas nativas não-`function` (ex.: `web_search_*`) são preservadas de
  forma opaca; `allowed_domains`/`blocked_domains` vazios são removidos porque a
  API rejeita array vazio nesses campos.
- A negociação com o fornecedor é sempre SSE (`stream: true` no corpo e
  `Accept: text/event-stream`), independentemente do `stream` pedido pelo cliente
  (ADR-019).
- Streaming é incremental real: cada evento SSE (`content_block_delta`,
  `message_delta`, etc.) vira um chunk OpenAI assim que chega, sem heartbeat nem
  buffer da resposta inteira.
- Erro antes do primeiro byte vira status HTTP (`anthropic_upstream_error`,
  `anthropic_timeout`, `anthropic_connection_error`); erro depois do início do
  stream vira evento `error` sanitizado, sem `[DONE]`.
- Autenticação sem técnicas de "cloaking"/fingerprint do cliente oficial — risco
  aceito e documentado no adendo do [ADR-018](../../../adr/ADR-018-credencial-oauth-da-assinatura.md).
- Quando a Anthropic responde com `retry-after`, o valor é normalizado para segundos
  inteiros e devolvido ao cliente no cabeçalho `retry-after`; valor inválido é
  descartado. O driver de streaming é compartilhado com o Codex, então a regra é a
  mesma nos dois adaptadores CLI.
- A telemetria registra `usageObserved`, indicando se o provedor chegou a reportar
  `usage` no stream. As métricas de forma do prompt (`promptCacheKey`,
  `prefixFingerprint`, `requestBodyBytes`, `inputItemCount`, `toolCount`,
  `toolSchemaBytes`) existem apenas no adaptador Codex.

## Fluxo resumido

Gateway resolve alias/modelo/effort -> traduz o corpo OpenAI para o corpo Messages
-> `AnthropicClient` injeta o token OAuth e chama a API -> SSE nativo é traduzido
evento a evento -> gateway devolve streaming incremental ou `chat.completion`
acumulado.

## Possíveis erros

`invalid_reasoning_effort`, `cli_unavailable`, `oauth_not_logged_in`,
`oauth_refresh_failed`, `anthropic_upstream_error`, `anthropic_timeout` e
`anthropic_connection_error`. Bloqueio de detecção de cliente não-oficial pela
Anthropic aparece como `anthropic_upstream_error` com status `403`/`429` —
consulte o risco residual no threat model.
