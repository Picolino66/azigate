# Provider Claude CLI

## Descrição

Provider experimental com oito aliases versionados e o sinônimo legado `claude-cli`. Usa o login existente e nunca migra silenciosamente para API key.

## Localização no código

`src/providers/`, `src/broker/executor.ts`, `src/broker/memory-executor.ts`,
`src/broker/session-correlation.ts`, `src/broker/capabilities.ts` e
`src/broker/viability-gate.ts`.

## Entrada

O mesmo subconjunto textual/function tool do Codex. Conteúdo multimodal é rejeitado. O campo público `model` seleciona apenas um alias fechado; `reasoning_effort` ou `reasoning.effort` aceita `low`, `medium`, `high`, `xhigh` ou `max`.

## Saída

Decisão validada e normalizada para Chat Completions JSON/SSE.

## Dependências

Claude CLI autenticado, Bubblewrap, `~/.claude` com modo `0700`,
`~/.claude.json` regular com modo `0600`, broker ativo e dois flags explícitos de
habilitação.

## Regras de negócio

- Print mode persistente com input/output `stream-json`, JSON schema, tools vazias
  e MCP estrito vazio. `stateless` preserva o modo JSON de uma chamada.
- Slash commands, Chrome, persistência e fontes de settings são desabilitados.
- Prompt suggestions são desabilitadas para evitar chamadas auxiliares.
- `dontAsk` não concede ferramentas; a lista de tools continua vazia.
- Cada alias mapeia para um único nome completo enviado por `--model`; `claude-cli` equivale a Sonnet 4.6.
- Omissão ou effort incompatível aplica o padrão do catálogo. Sonnet 4.5 e Haiku 4.5 não recebem `--effort`.
- O formato plano tem precedência sobre o aninhado; `reasoning: false` usa o default do modelo.
- O protocolo v6 e o broker validam novamente provider, modelo e matriz de effort.
- Thinking permanece privado ao CLI e não é publicado em Chat Completions ou SSE.
- A versão instalada deve oferecer todos os flags.
- O startup valida proprietário, tipo, tamanho máximo de 1 MiB e permissões do
  `CLAUDE_CONFIG_PATH` e de `.claude/.credentials.json`. Cada sessão recebe uma
  cópia `0600` da configuração e monta somente a credencial no home efêmero; o
  arquivo original nunca é montado na sandbox.
- A correlação em RAM reutiliza o processo somente com um prefixo semântico exato.
  Mudança de effort cria sessão nova porque `--effort` pertence à inicialização.
- Usage soma input novo, criação de cache e leitura de cache. O custo do CLI é
  registrado como estimativa, não como porcentagem da cota.
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

Gateway resolve alias/modelo/default -> protocolo v6 -> broker correlaciona o
prefixo -> Claude recebe transcript completo ou delta -> structured output é
validado -> o agente recebe somente a decisão.

## Possíveis erros

Os mesmos erros CLI. Falha no gate ou no login resulta em `cli_unavailable` e
omissão do catálogo. Arquivo `~/.claude.json` ausente, permissivo, grande demais ou
com proprietário divergente produz o código sanitizado `config_file_unavailable`.
Limite da conta/provedor encerra a execução como `cli_execution_failed`, sem
registrar a resposta bruta.
