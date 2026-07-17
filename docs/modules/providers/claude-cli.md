# Provider Claude CLI

## Descrição

Segunda fase experimental, exposta como `claude-cli` somente depois do gate. Usa o modelo padrão e o login existente; nunca migra silenciosamente para API key.

## Localização no código

`src/providers/`, `src/broker/executor.ts`, `src/broker/capabilities.ts` e `src/broker/viability-gate.ts`.

## Entrada

O mesmo subconjunto textual/function tool do Codex. Conteúdo multimodal é rejeitado.

## Saída

Decisão validada e normalizada para Chat Completions JSON/SSE.

## Dependências

Claude CLI autenticado, Bubblewrap, `~/.claude` privado, broker ativo e dois flags explícitos de habilitação.

## Regras de negócio

- Print mode, JSON schema, tools vazias e MCP estrito vazio.
- Slash commands, Chrome, persistência e fontes de settings são desabilitados.
- `dontAsk` não concede ferramentas; a lista de tools continua vazia.
- A versão instalada deve oferecer todos os flags.
- Bloqueio de autenticação/política mantém o alias indisponível; nenhuma API key é introduzida.

## Evidência de viabilidade

Em 16/07/2026, a versão instalada `Claude Code 2.1.150` passou 20/20 saídas estruturais, 20/20 categorias e produziu zero evento de ferramenta local. O resultado habilita a continuidade da segunda fase; não publica o alias automaticamente.

## Fluxo resumido

Gateway normaliza -> broker cria settings/MCP vazios -> Claude roda isolado -> structured output é validado -> Qwen recebe a decisão.

## Possíveis erros

Os mesmos erros CLI. Falha no gate ou no login resulta em `cli_unavailable` e omissão do catálogo.
