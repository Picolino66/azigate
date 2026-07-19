# Provider Claude CLI

## Descrição

Provider experimental com oito aliases versionados e o sinônimo legado `claude-cli`. Usa o login existente e nunca migra silenciosamente para API key.

## Localização no código

`src/providers/`, `src/broker/executor.ts`, `src/broker/capabilities.ts` e `src/broker/viability-gate.ts`.

## Entrada

O mesmo subconjunto textual/function tool do Codex. Conteúdo multimodal é rejeitado. O campo público `model` seleciona apenas um alias fechado; `reasoning_effort` aceita `low`, `medium`, `high`, `xhigh` ou `max`.

## Saída

Decisão validada e normalizada para Chat Completions JSON/SSE.

## Dependências

Claude CLI autenticado, Bubblewrap, `~/.claude` privado, broker ativo e dois flags explícitos de habilitação.

## Regras de negócio

- Print mode, JSON schema, tools vazias e MCP estrito vazio.
- Slash commands, Chrome, persistência e fontes de settings são desabilitados.
- `dontAsk` não concede ferramentas; a lista de tools continua vazia.
- Cada alias mapeia para um único nome completo enviado por `--model`; `claude-cli` equivale a Sonnet 4.6.
- Omissão ou effort incompatível aplica o padrão do catálogo. Sonnet 4.5 e Haiku 4.5 não recebem `--effort`.
- O protocolo v4 e o broker validam novamente provider, modelo e matriz de effort.
- Thinking permanece privado ao CLI e não é publicado em Chat Completions ou SSE.
- A versão instalada deve oferecer todos os flags.
- Bloqueio de autenticação/política mantém o alias indisponível; nenhuma API key é introduzida.

## Evidência de viabilidade

A evidência anterior do modelo padrão no protocolo v3 não certifica os oito modelos versionados. Cada modelo do protocolo v4 precisa passar 20/20 estruturas, zero ferramenta local, ao menos 18/20 categorias e seus smokes de effort. Falha individual omite somente o alias correspondente da allowlist.

Gate real executado com Claude Code `2.1.214` em 18/07/2026:

| Modelo | Estrutura | Categoria | Ferramenta local | Efforts | Publicação |
|---|---:|---:|---:|---:|---|
| Fable 5 | 20/20 | 20/20 | 0 | 4/4 | aprovada |
| Sonnet 5 | 20/20 | 20/20 | 0 | 4/4 | aprovada |
| Opus 4.8 | 20/20 | 20/20 | 0 | 4/4 | aprovada |
| Opus 4.7 | 19/20 | 19/20 | 0 | 4/4 | reprovada |
| Opus 4.6 | 20/20 | 20/20 | 0 | 3/3 | aprovada |
| Sonnet 4.6 | 18/20 | 18/20 | 0 | 3/3 | reprovada; inclui `claude-cli` |
| Sonnet 4.5 | 20/20 | 20/20 | 0 | não aplicável | aprovada |
| Haiku 4.5 | 19/20 | 11/20 | 0 | não aplicável | reprovada |

Assim, a allowlist local publica somente `claude-cli-fable-5`, `claude-cli-sonnet-5`, `claude-cli-opus-4.8`, `claude-cli-opus-4.6` e `claude-cli-sonnet-4.5`. Os demais aliases continuam reservados e recebem `403 model_not_allowed`.

## Fluxo resumido

Gateway resolve alias/modelo/default -> protocolo v4 -> broker revalida -> Claude roda isolado com `--model`/`--effort` fixos -> structured output é validado -> Qwen recebe somente a decisão.

## Possíveis erros

Os mesmos erros CLI. Falha no gate ou no login resulta em `cli_unavailable` e omissão do catálogo.
