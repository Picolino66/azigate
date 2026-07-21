# Provider Codex CLI

## Descrição

Aliases experimentais Codex que escolhem um modelo fixo da sessão autenticada. O Codex só produz texto ou uma decisão estruturada de tool calls para o agente cliente.

## Localização no código

`src/providers/`, `src/broker/executor.ts`, `src/broker/memory-executor.ts`,
`src/broker/session-correlation.ts`, `src/broker/capabilities.ts` e
`src/broker/viability-gate.ts`.

## Entrada

Mensagens textuais, function tools, `tool_choice` e `parallel_tool_calls`. Os modelos públicos são `codex-cli-sol`, `codex-cli-terra`, `codex-cli-luna`, `codex-cli-5.5` e `codex-cli-5.4`, mapeados para `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` e `gpt-5.4`. `codex-cli` continua como sinônimo de `gpt-5.4`. Effort aceita `reasoning_effort` ou `reasoning.effort` com `low`, `medium`, `high`, `xhigh` ou `max`.

## Saída

Chat Completion com `content` ou `tool_calls`. IDs são criados pelo gateway. Em streaming, heartbeat precede a decisão final atômica.

## Dependências

Codex CLI autenticado, Bubblewrap, `~/.codex` privado, broker ativo e `ENABLE_CODEX_CLI=true`.

## Regras de negócio

- Em `memory`, um App Server privado cria threads com `ephemeral: true`; cada
  `turn/start` recebe modelo/effort validados e `outputSchema`. O modo `stateless`
  de contingência conserva `codex exec --ephemeral`/JSONL.
- O modelo chega ao broker somente pela allowlist interna. No App Server ele é
  definido em `thread/start`; em contingência vira `--model` no argv fixo.
- O default de todos os modelos é `medium`; `max` é reduzido para `xhigh`. O valor
  efetivo chega pelo protocolo v6 e é enviado em `turn/start`. No modo stateless,
  vira `-c model_reasoning_effort="..."` reconstruído.
- `reasoning_effort` plano tem precedência sobre `reasoning.effort`; `reasoning: false`, ausência ou objeto sem effort usa o default.
- Configuração e rules do usuário ignoradas; somente `auth.json` entra no home
  efêmero do App Server.
- Sandbox `read-only`, approval `never` e shell/apps/browser/computer/hooks/multi-agent desabilitados.
- Qualquer evento de ferramenta local invalida a execução.
- O gate usa 10 cenários duas vezes: 100% estrutural, zero ferramentas locais e 90% de categoria.
- O startup não faz inferência: interpreta `debug models --bundled` e exige todos
  os modelos/efforts fixados. A execução real mantém `--strict-config`.
- A correlação em RAM reutiliza uma thread somente com um prefixo semântico exato.
  Troca de effort é aplicada por turno sem perder a thread; divergência ou troca de
  modelo cria thread nova.
- Usage usa `thread/tokenUsage/updated.tokenUsage.last`: input já inclui cache,
  cached/reasoning são subconjuntos e não são somados novamente.
- A partir do `codex-cli 0.144`, o App Server envia `turn/completed` com `items`
  vazios (`itemsView: "notLoaded"`); a decisão vem do último `item/completed` de
  tipo `agentMessage` do turno, com o formato antigo mantido como preferência
  quando `items` vier populado. As notificações `remoteControl/status/changed`
  (a feature está `removed` e sempre reporta `disabled`) e `warning` são
  toleradas como metadados; eventos MCP, de shell ou de subagente continuam
  encerrando a sessão com `invalid_cli_output`.

## Evidência de viabilidade

Em 16/07/2026, a versão instalada `codex-cli 0.133.0` passou 20/20 saídas estruturais, 20/20 categorias e produziu zero evento de ferramenta local. O gate deve ser repetido para cada modelo publicado e após upgrades.

Em 20/07/2026, após upgrade para `codex-cli 0.144.6`, smokes isolados no effort
`medium` aprovaram Sol, Terra e Luna com 1/1 estrutura válida, 1/1 categoria e
zero ferramenta local por modelo. Isso valida o caminho funcional, mas não
substitui o gate completo de 20 cenários de cada modelo.

## Fluxo resumido

Gateway normaliza modelo/effort -> protocolo v6 -> broker correlaciona o prefixo ->
App Server recebe transcript completo ou delta -> broker recusa itens locais e
valida a mensagem final -> gateway valida allowlist -> o agente recebe a decisão.

## Possíveis erros

`invalid_cli_request`, `cli_context_too_large`, `cli_busy`, `invalid_cli_output`,
`cli_execution_failed`, `cli_unavailable` e `cli_timeout`.
