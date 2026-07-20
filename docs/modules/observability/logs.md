# Logs de requisição

## Descrição

O gateway emite uma linha JSON por requisição concluída. No stdout interativo, o valor de `model` recebe cor ANSI para facilitar a leitura; cada alias conhecido possui cor própria.

## Localização no código

`src/app.ts`, `src/routes/chat.ts`, `src/providers/openai-response.ts`,
`src/observability/log-colors.ts`, `src/observability/metrics.ts` e `src/types.ts`.

## Entrada

O modelo é o campo público `model`. Para Codex e Claude, o `effort` é obtido após a normalização interna. Para o upstream, só são registrados os valores seguros conhecidos de `reasoning_effort`.

## Saída

O evento final pode incluir `requestId`, método, rota, status, duração,
`stream`, `model`, `effort`, status upstream, usage padrão, detalhes de cache,
`cacheHitPercent`, `sessionMode`, `sessionReused`, `transcriptBytes` e códigos
sanitizados. A cor ANSI é uma apresentação do stdout: não altera a semântica.

## Dependências

Fastify, Pino e a normalização do request CLI.

## Regras de negócio

- IDs conhecidos recebem cores ANSI estáveis (por exemplo `deepseek-v4-flash` verde, `deepseek-v4-pro` azul e `codex-cli` vermelho); cada outro alias conhecido recebe outra cor.
- Para Claude, o log usa o effort efetivamente enviado ao broker/CLI, já com default ou downgrade aplicados.
- Para Codex, o log usa o valor efetivo enviado como `model_reasoning_effort`; uma solicitação `max` aparece como `xhigh`.
- Para o upstream, valores reconhecidos são registrados; ausência ou valor desconhecido vira `não_informado`, sem alterar o payload opaco enviado ao upstream.
- Claude registra `freshInputTokens`, `cacheCreationInputTokens` e
  `cacheReadInputTokens`; `inputTokens` é a soma lógica dessas parcelas.
- Codex registra input total, `cachedInputTokens`, `freshInputTokens` e
  `reasoningOutputTokens`; cache e reasoning são subconjuntos, não parcelas extras.
- `cacheHitPercent` usa cache lido/input lógico. `estimatedCostUsd`, quando
  fornecido pelo Claude CLI, é estimativa. Nenhum dos dois representa a porcentagem
  da cota mostrada pelo provider.
- `sessionReused=true` significa que um único prefixo exato foi reutilizado em RAM.
  `transcriptBytes` mede somente mensagens e tools normalizadas.
- Erros de validação podem registrar códigos seguros como
  `invalid_content_shape`, `invalid_tool_schema` e `invalid_historical_tool_calls`.
- Nunca registrar mensagens, prompts, bodies, respostas, tool arguments, headers, credenciais ou stdout/stderr do CLI.

## Fluxo resumido

Chat valida o request -> resolve provider -> normaliza o request CLI quando aplicável -> grava `model` e `effort` na telemetria -> hook `onResponse` emite os metadados -> destino stdout colore somente o valor de `model`.

## Possíveis erros

Não há erro público adicional. Falhas de validação CLI continuam usando os erros sanitizados do contrato existente; quando não há effort válido normalizado, nenhum valor controlado pelo cliente é registrado.
