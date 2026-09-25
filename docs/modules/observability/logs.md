# Logs de requisição

## Descrição

O gateway emite uma linha JSON por requisição concluída. No stdout interativo, o valor de `model` recebe cor ANSI para facilitar a leitura; cada alias conhecido possui cor própria.

## Localização no código

`src/app.ts`, `src/routes/chat.ts`, `src/providers/cli-completion.ts`,
`src/observability/log-colors.ts`, `src/observability/metrics.ts` e `src/types.ts`.

## Entrada

O modelo é o campo público `model`. Para Codex e Claude, o `effort` é obtido após a normalização de `src/providers/reasoning-effort.ts`. Para o upstream, só são registrados os valores seguros conhecidos de `reasoning_effort`.

## Saída

O evento final pode incluir `requestId`, método, rota, status, duração,
`stream`, `model`, `effort`, status upstream, usage padrão, detalhes de cache/
reasoning, `cacheHitPercent`, `freshInputTokens`, as métricas de forma do prompt e
código de erro sanitizado. A cor ANSI é uma apresentação do stdout: não altera a
semântica.

### Campos de token

| Campo | Significado |
|---|---|
| `inputTokens` | Input lógico total reportado pelo provedor |
| `cachedInputTokens` | Parcela do input servida pelo cache (subconjunto, não parcela extra) |
| `freshInputTokens` | `inputTokens - cachedInputTokens`, com piso em zero: o que foi efetivamente reprocessado |
| `outputTokens` | Saída total |
| `reasoningOutputTokens` | Reasoning, subconjunto da saída |
| `totalTokens` | Volume lógico, não porcentagem de cota |
| `cacheHitPercent` | `cachedInputTokens / inputTokens`, só quando o provedor informa cache |
| `usageObserved` | `false` quando o provedor não chegou a reportar `usage` (erro, `429`, cancelamento) |

### Métricas de forma do prompt (somente Codex)

| Campo | Significado |
|---|---|
| `promptCacheKey` | Digest opaco enviado como `prompt_cache_key`; permite correlacionar turnos da mesma conversa |
| `prefixFingerprint` | Digest de 16 hex dos três primeiros itens do `input`; muda quando o cliente reescreve o começo da conversa |
| `requestBodyBytes` | Tamanho em bytes do corpo serializado enviado à Responses API |
| `inputItemCount` | Quantidade de itens em `input[]` |
| `toolCount` | Quantidade de ferramentas declaradas |
| `toolSchemaBytes` | Tamanho em bytes do array `tools` serializado |
| `retryCount` | Tentativas repetidas antes da resposta considerada |

Todos são contagens ou digests unidirecionais. Nenhum permite reconstruir mensagem,
prompt, argumento de ferramenta ou schema.

### Diagnóstico de renovação OAuth (Codex e Claude)

| Campo | Significado |
|---|---|
| `oauthRefreshStatus` | Status HTTP do endpoint de token quando `oauth_refresh_failed` teve resposta HTTP |
| `oauthRefreshError` | Código OAuth devolvido (ex.: `invalid_grant`), aceito só por allowlist, ou `nao_informado`/`resposta_invalida`/`falha_de_transporte` |

`error_description`, mensagens livres e tokens nunca são registrados. Detalhes em
[Renovação de token OAuth](../providers/oauth-token-renewal.md).

## Dependências

Fastify, Pino e a camada de tradução (para extrair usage dos chunks OpenAI).

## Regras de negócio

- IDs conhecidos recebem cores ANSI estáveis (por exemplo `deepseek-v4-flash` verde, `deepseek-v4-pro` azul e `codex-cli` vermelho); cada outro alias conhecido recebe outra cor.
- Para Claude, o log usa o effort efetivamente enviado à Messages API, já com default ou downgrade aplicados.
- Para Codex, o log usa o valor efetivo enviado como `reasoning.effort`; uma solicitação `max` aparece como `xhigh`.
- Para o upstream, valores reconhecidos são registrados; ausência ou valor desconhecido vira `não_informado`, sem alterar o payload opaco enviado ao upstream.
- Claude registra `cachedInputTokens` (leitura de cache) quando informado pela
  API; `inputTokens` é o total lógico reportado.
- `freshInputTokens` é derivado no gateway, não vem do provedor. Quando o provedor
  não informa `cached_tokens`, o valor é o input inteiro — nunca um número inventado.
- `usageObserved` é gravado como `false` antes da chamada ao provedor e só vira
  `true` quando o `usage` chega. Um turno que termina em `429`, timeout ou
  cancelamento permanece no log com a forma do prompt e **sem** campos de token.
- As métricas de forma do prompt são registradas antes do envio, então existem mesmo
  quando a requisição falha. Elas descrevem a estrutura do que foi enviado, nunca o
  conteúdo.
- `promptCacheKey` é o mesmo digest enviado ao fornecedor. Registrá-lo é deliberado
  (adendo do ADR-020): sem ele não há como correlacionar turnos da mesma conversa
  para diagnosticar queda de cache. O conteúdo que originou o digest continua
  proibido no log.
- Codex registra input total, `cachedInputTokens` e `reasoningOutputTokens`;
  cache e reasoning são subconjuntos, não parcelas extras.
- O `usage` é extraído dos chunks OpenAI à medida que são traduzidos, tanto no
  modo streaming quanto no bufferizado; não depende de o gateway acumular a
  resposta.
- `cacheHitPercent` usa cache lido/input lógico. Não representa a porcentagem da
  cota mostrada pelo provider.
- Nunca registrar mensagens, prompts, bodies, respostas, tool arguments, headers, credenciais, tokens OAuth ou saída bruta do provedor.

## Fluxo resumido

Chat valida o request -> resolve provider -> normaliza effort -> traduz e chama o
adaptador -> grava `model` e `effort` na telemetria -> o driver de streaming
extrai `usage` dos chunks OpenAI e chama `observeProviderUsage` -> hook
`onResponse` emite os metadados -> destino stdout colore somente o valor de
`model`.

## Possíveis erros

Não há erro público adicional. Falhas de reasoning effort ou de provedor
continuam usando os erros sanitizados do contrato existente; quando não há
effort válido normalizado, nenhum valor controlado pelo cliente é registrado.
