# Incidente: aliases Codex com `invalid_cli_output` no modo memory após upgrade 0.144.6

## Resumo

Em 20/07/2026 à noite, todos os aliases `codex-cli-*` passaram a responder `502`
com `InvalidCliOutputError` no gateway, enquanto DeepSeek e os aliases Claude
continuaram normais. O broker reportava `ready` e o gate de smoke do upgrade
(modo `exec`) havia passado no mesmo dia. Severidade operacional: P2.

## Diagnóstico

- As falhas ocorriam em dois padrões de latência: ~280 ms (antes do turno
  começar) e ~4 s (no meio do turno), sempre no modo `memory` (App Server).
- O journal do broker não tinha nenhuma linha por requisição, apenas
  `broker_started`; o diagnóstico exigiu reproduzir o protocolo App Server
  manualmente com o mesmo argv do broker.
- A reprodução mostrou três divergências do `codex-cli 0.144.6`:
  1. a notificação `remoteControl/status/changed` chega logo após `thread/start`
     e não estava na allowlist de notificações benignas — derrubava a sessão
     antes do turno (falhas de ~280 ms);
  2. `turn/completed` passou a chegar com `items: []` e
     `itemsView: "notLoaded"`, então a decisão não estava mais no evento final
     (falhas de ~4 s, após o turno completar);
  3. com HOME real, também surgem `mcpServer/startupStatus/updated` e `warning`;
     na sandbox do broker os `--disable` existentes suprimem o MCP interno, e o
     aviso de skills não ocorre porque o home efêmero não tem skills.
- O smoke do upgrade não detectou o problema porque o gate usa o modo `exec`
  stateless, cujo protocolo JSONL não mudou.

Nenhum prompt, resposta, stderr bruto, argumento de ferramenta ou credencial foi
registrado durante o diagnóstico.

## Causa

Drift de protocolo do App Server no upgrade `0.133.0 -> 0.144.6`: notificações
novas fora da allowlist e decisão movida do `turn/completed` para o último
`item/completed` `agentMessage`. Como `UnexpectedCliToolEventError` estende
`InvalidCliOutputError`, o gateway só via o código genérico `invalid_cli_output`.

## Correção

- `remoteControl/status/changed` e `warning` passaram a ser notificações
  benignas; eventos MCP, shell, hook, app e subagente continuam encerrando a
  sessão com erro seguro (regressão coberta por teste).
- A decisão do turno usa `turn/completed.items` quando populado e cai para o
  último `item/completed` `agentMessage` quando vazio.
- O broker agora emite `broker_execute_failed` (requestId, provider, classe de
  erro e código sanitizado) para cada falha de `/execute`.

## Prevenção

- Após qualquer upgrade do Codex CLI, validar também o modo `memory` (uma
  conversa real multi-turn), não somente o gate `exec`.
- Em regressão recorrente, rebaixar somente o provider afetado com
  `BROKER_CODEX_SESSION_MODE=stateless` enquanto se investiga.
