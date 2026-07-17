# Provider Codex CLI

## Descrição

Alias experimental `codex-cli` que usa o modelo padrão da sessão Codex autenticada. O Codex só produz texto ou uma decisão estruturada de tool calls para o Qwen.

## Localização no código

`src/providers/`, `src/broker/executor.ts`, `src/broker/capabilities.ts` e `src/broker/viability-gate.ts`.

## Entrada

Mensagens textuais, function tools, `tool_choice` e `parallel_tool_calls`. O modelo público é sempre `codex-cli`; nenhum modelo interno é escolhido pelo cliente.

## Saída

Chat Completion com `content` ou `tool_calls`. IDs são criados pelo gateway. Em streaming, heartbeat precede a decisão final atômica.

## Dependências

Codex CLI autenticado, Bubblewrap, `~/.codex` privado, broker ativo e `ENABLE_CODEX_CLI=true`.

## Regras de negócio

- Execução `--ephemeral`, JSONL e output schema.
- Configuração e rules do usuário ignoradas.
- Sandbox `read-only`, approval `never` e shell/apps/browser/computer/hooks/multi-agent desabilitados.
- Qualquer evento de ferramenta local invalida a execução.
- O gate usa 10 cenários duas vezes: 100% estrutural, zero ferramentas locais e 90% de categoria.

## Evidência de viabilidade

Em 16/07/2026, a versão instalada `codex-cli 0.133.0` passou 20/20 saídas estruturais, 20/20 categorias e produziu zero evento de ferramenta local. Isso aprova a versão testada, mas o alias permanece opt-in e o gate deve ser repetido após upgrades.

## Fluxo resumido

Gateway normaliza -> broker cria prompt/schema -> Codex roda isolado -> broker inspeciona JSONL/final -> gateway valida allowlist -> Qwen recebe decisão.

## Possíveis erros

`invalid_cli_request`, `cli_busy`, `invalid_cli_output`, `cli_execution_failed`, `cli_unavailable` e `cli_timeout`.
