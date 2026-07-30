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
reasoning, `cacheHitPercent` e código de erro sanitizado. A cor ANSI é uma
apresentação do stdout: não altera a semântica.

## Dependências

Fastify, Pino e a camada de tradução (para extrair usage dos chunks OpenAI).

## Regras de negócio

- IDs conhecidos recebem cores ANSI estáveis (por exemplo `deepseek-v4-flash` verde, `deepseek-v4-pro` azul e `codex-cli` vermelho); cada outro alias conhecido recebe outra cor.
- Para Claude, o log usa o effort efetivamente enviado à Messages API, já com default ou downgrade aplicados.
- Para Codex, o log usa o valor efetivo enviado como `reasoning.effort`; uma solicitação `max` aparece como `xhigh`.
- Para o upstream, valores reconhecidos são registrados; ausência ou valor desconhecido vira `não_informado`, sem alterar o payload opaco enviado ao upstream.
- Claude registra `cachedInputTokens` (leitura de cache) quando informado pela
  API; `inputTokens` é o total lógico reportado.
- Codex registra input total, `cachedInputTokens` e `reasoningOutputTokens`;
  cache e reasoning são subconjuntos, não parcelas extras.
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
