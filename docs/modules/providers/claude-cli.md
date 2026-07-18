# Provider Claude CLI

## Descrição

Provider experimental exposto como alias único `claude-cli` depois dos gates da versão instalada. Usa o modelo padrão e o login existente; nunca migra silenciosamente para API key.

## Localização no código

`src/providers/`, `src/broker/executor.ts`, `src/broker/capabilities.ts` e `src/broker/viability-gate.ts`.

## Entrada

O mesmo subconjunto textual/function tool do Codex. Conteúdo multimodal é rejeitado. `reasoning_effort` é opcional e aceita `low`, `medium`, `high`, `xhigh` ou `max`.

## Saída

Decisão validada e normalizada para Chat Completions JSON/SSE.

## Dependências

Claude CLI autenticado, Bubblewrap, `~/.claude` privado, broker ativo e dois flags explícitos de habilitação.

## Regras de negócio

- Print mode, JSON schema, tools vazias e MCP estrito vazio.
- Slash commands, Chrome, persistência e fontes de settings são desabilitados.
- `dontAsk` não concede ferramentas; a lista de tools continua vazia.
- O alias não usa `--model`: o modelo é resolvido pela conta. Effort validado é o único argumento variável e entra como `--effort <nível>`.
- Omissão de `reasoning_effort` preserva o padrão da conta; modelos podem reduzir níveis não suportados.
- Thinking permanece privado ao CLI e não é publicado em Chat Completions ou SSE.
- A versão instalada deve oferecer todos os flags.
- Bloqueio de autenticação/política mantém o alias indisponível; nenhuma API key é introduzida.

## Evidência de viabilidade

Em 18/07/2026, `Claude Code 2.1.214` passou o gate completo com effort `high`: 20/20 saídas estruturais, 20/20 categorias e zero ferramenta local. Os smokes `low`, `medium`, `xhigh` e `max` passaram 4/4 com zero ferramenta local. A evidência autoriza a publicação opt-in desta versão; um novo upgrade exige repetir ambos os gates.

## Fluxo resumido

Gateway normaliza e valida effort -> protocolo v3 -> broker cria settings/MCP vazios -> Claude roda isolado com argv fixo -> structured output é validado -> Qwen recebe somente a decisão.

## Possíveis erros

Os mesmos erros CLI. Falha no gate ou no login resulta em `cli_unavailable` e omissão do catálogo.
