# Providers

## Descrição

Registry multiprovedor que mantém um upstream OpenAI-compatible (DeepSeek por
padrão) e adaptadores HTTP nativos para Codex (Responses API) e Claude (Messages
API), autenticados pela assinatura do operador via OAuth.

## Localização no código

- `src/providers/registry.ts`: roteamento por `model`, sem fallback;
- `src/providers/anthropic-client.ts` / `src/providers/codex-client.ts`: clientes HTTP Undici;
- `src/providers/oauth/`: fluxo OAuth/PKCE, armazenamento e renovação de token;
- `src/providers/reasoning-effort.ts`: normalização de `reasoning_effort`/`reasoning.effort`;
- `src/providers/cli-completion.ts`: driver de streaming/buffer que consome o SSE traduzido;
- `src/translation/`: conversão pura entre OpenAI Chat Completions e os formatos nativos;
- `src/upstream/`: adaptador de upstream (DeepSeek por padrão).

## Entrada

`model`, `messages`, `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning_effort`/`reasoning.effort` e `stream` em `POST /v1/chat/completions`.

## Saída

Chat Completion JSON, SSE do upstream opaco, ou JSON/SSE traduzido a partir da
Messages/Responses API — incluindo multimodal e tool calls, sem a restrição
textual da arquitetura anterior. O catálogo expõe modelos do upstream e aliases
saudáveis (habilitados e com token OAuth salvo).

## Dependências

Fastify, Undici, e as APIs HTTPS reais da Anthropic e da OpenAI/Codex. Nenhuma
dependência de subprocesso, sandbox ou socket local.

## Regras de negócio

- Não há fallback automático.
- Aliases reservados nunca são enviados ao upstream.
- O agente cliente é o único executor de ferramentas.
- Um alias só é publicado se habilitado e com token OAuth presente em disco.
- Cada adaptador reconstrói sua própria `Authorization`; a credencial Bearer do
  cliente nunca segue adiante.
- Falhas de provedor preservam o status HTTP quando ocorrem antes do primeiro
  byte de resposta; depois do início do stream, viram evento `error` sanitizado.

## Fluxo resumido

Autenticar -> aplicar allowlists -> resolver provider -> normalizar effort ->
traduzir o corpo para o formato nativo -> chamar o adaptador HTTP -> traduzir a
resposta/stream de volta para OpenAI -> devolver ao agente.

## Possíveis erros

`model_not_allowed`, `invalid_reasoning_effort`, `cli_unavailable`,
`providers_unavailable`, `oauth_not_logged_in`, `oauth_refresh_failed`,
`codex_upstream_error`, `anthropic_upstream_error`, `codex_timeout`/`anthropic_timeout`
e `codex_connection_error`/`anthropic_connection_error`.

## Features

- [Upstream OpenAI-compatible (DeepSeek por padrão)](./deepseek.md)
- [Codex CLI](./codex-cli.md)
- [Claude CLI](./claude-cli.md)
- [Renovação de token OAuth](./oauth-token-renewal.md)
- [Camada de tradução](../translation/index.md)
