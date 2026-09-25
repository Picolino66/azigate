# Fixtures de contrato dos agentes nativos

Uma fixture por versão certificada da CLI (ADR-022). Nenhuma contém prompt real, token ou
dado pessoal; paths e identificadores foram trocados por valores fictícios.

| Arquivo | Procedência |
|---|---|
| `agy-1.2.10.jsonl` | `init` e `result` `ERROR` capturados da CLI 1.2.10 no host em 25/09/2026 com comandos que não consomem cota; `result` `SUCCESS` segue o mesmo schema observado |
| `agy-1.2.11.jsonl` | mesma captura repetida na CLI 1.2.11 (atualização automática durante o ciclo): `init`, `result` `ERROR`, recusa de `control_request` e conversa inexistente idênticos; changelog sem mudança de `stream-json` |
| `claude-2.1.280.jsonl` | `control_response` do `initialize` capturado (conta omitida); demais mensagens seguem o formato `stream-json` documentado do Claude Code SDK |
| `codex-0.144.6.jsonl` | resposta de `initialize` e `remoteControl/status/changed` capturadas; demais notificações seguem o schema gerado por `codex app-server generate-json-schema` da mesma versão |

Mensagens de `step_update` do AGY não foram capturadas (exigem um turno real); o mapeamento
é tolerante e validado pela suíte manual `npm run test:agents:real`.
