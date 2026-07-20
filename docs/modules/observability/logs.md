# Logs de requisição

## Descrição

O gateway emite uma linha JSON por requisição concluída. No stdout interativo, o valor de `model` recebe cor ANSI para facilitar a leitura; cada alias conhecido possui cor própria.

## Localização no código

`src/app.ts`, `src/routes/chat.ts`, `src/observability/log-colors.ts` e `src/types.ts`.

## Entrada

O modelo é o campo público `model`. Para Codex e Claude, o `effort` é obtido após a normalização interna. Para o upstream, só são registrados os valores seguros conhecidos de `reasoning_effort`.

## Saída

O evento final pode incluir `requestId`, método, rota, status, duração, `stream`, `model`, `effort`, status upstream, uso de tokens e código sanitizado de erro. A cor ANSI é uma apresentação do stdout: não altera a semântica dos demais campos.

## Dependências

Fastify, Pino e a normalização do request CLI.

## Regras de negócio

- IDs conhecidos recebem cores ANSI estáveis (por exemplo `deepseek-v4-flash` verde, `deepseek-v4-pro` azul e `codex-cli` vermelho); cada outro alias conhecido recebe outra cor.
- Para Claude, o log usa o effort efetivamente enviado ao broker/CLI, já com default ou downgrade aplicados.
- Para Codex, o log usa o valor efetivo enviado como `model_reasoning_effort`; uma solicitação `max` aparece como `xhigh`.
- Para o upstream, valores reconhecidos são registrados; ausência ou valor desconhecido vira `não_informado`, sem alterar o payload opaco enviado ao upstream.
- Nunca registrar mensagens, prompts, bodies, respostas, tool arguments, headers, credenciais ou stdout/stderr do CLI.

## Fluxo resumido

Chat valida o request -> resolve provider -> normaliza o request CLI quando aplicável -> grava `model` e `effort` na telemetria -> hook `onResponse` emite os metadados -> destino stdout colore somente o valor de `model`.

## Possíveis erros

Não há erro público adicional. Falhas de validação CLI continuam usando os erros sanitizados do contrato existente; quando não há effort válido normalizado, nenhum valor controlado pelo cliente é registrado.
