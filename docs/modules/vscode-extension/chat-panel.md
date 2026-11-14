# Painel de agentes

## Descrição

WebviewView `azigate.chat` no contêiner **Azigate** da barra de atividades. O usuário escolhe o
agente (Claude, Codex ou AGY) e o workspace e envia mensagens. O painel mostra o texto do agente
em streaming, as ferramentas executadas no projeto, as falhas, os pedidos de aprovação e o uso de
tokens ao fim do turno.

## Localização no código

- `src/vscode-extension/session-controller.ts`: `SessionController`, com estado, sessão, SSE e
  aprovações, sem depender do VS Code;
- `src/vscode-extension/protocol.ts`: mensagens webview ↔ host e `parseInboundMessage`;
- `src/vscode-extension/webview.ts`: HTML, CSS e JS do painel e `createNonce`;
- `src/vscode-extension/extension.ts`: registro da view, dos comandos e das notificações.

## Entrada

Mensagens do webview, validadas por `parseInboundMessage`: `ready`, `send {text}` (até 100 mil
caracteres), `cancel`, `newSession`, `refresh`, `selectProvider {provider}`,
`selectWorkspace {workspace}`, `decide {approvalId, decision}`, `startServer` e `stopServer`.
Qualquer outro formato é descartado. Comandos: **Azigate: Nova sessão** e **Azigate: Mostrar log**.

## Saída

Mensagens para o webview: `state` (agente, disponibilidade por provider, workspaces, worker que
expõe o workspace, sessão, turno em andamento, Workspace Server e conexão), `entry` (`user`,
`agent`, `tool`, `tool-failed`, `info`, `error`, `usage`), `delta`, `approval`,
`approvalResolved` e `reset`. Chamadas à Agent API: `GET providers` e `workers`,
`POST sessions`, `turns`, `cancel` e `approvals/:id`, `GET sessions/:id/events` (SSE) e
`DELETE sessions/:id`.

## Dependências

[Agent API](../../../specs/agent-api.md) (`AgentApi` de `src/agent-client/api.ts`),
`toolLabel` e `formatUsage` de `src/agent-client/render.ts` e a
[conexão](./connection.md).

## Regras de negócio

- A primeira mensagem cria a sessão com `{provider, workspace, worker}`, todos por ID. O worker
  é o único Workspace Server conectado que expõe o workspace. Nenhum worker ou mais de um é erro
  mostrado no painel, sem criar sessão.
- Um turno por vez: enviar durante um turno mostra erro, e **Cancelar** chama
  `POST /cancel`.
- Só eventos do turno corrente são exibidos. O `turn.started` do SSE pode chegar antes da
  resposta do `POST turns`.
- Aprovação: o card mostra **Permitir** e **Negar**. Com o painel oculto, o host mostra uma
  notificação com **Permitir**, **Negar** e **Abrir painel**. Só **Permitir** envia `allow`.
  Fechar a notificação não decide nada, e o agentd nega ao expirar. Uma aprovação só é decidida
  uma vez. IDs desconhecidos ou já resolvidos são ignorados, e `approval_already_resolved` é
  tolerado.
- `approval.resolved` com `reason` `timeout`, `session_closed` ou `cancelled` aparece como negada.
- Trocar de agente ou de workspace encerra a sessão atual (`DELETE`), e a próxima mensagem cria
  outra. **Nova sessão** faz o mesmo e limpa o painel.
- Se o agentd encerra o stream de eventos, o painel avisa e descarta a sessão.
- Fechar o VS Code ou desativar a extensão encerra a sessão aberta.
- O texto do agente é inserido só por `textContent`. A CSP do webview é `default-src 'none'`, com
  script e estilo por nonce e sem rede.

## Fluxo resumido

`ready` → `GET providers` e `workers` → `state` → `send` → `POST sessions` (na primeira vez) →
SSE `events?after=` → `POST turns` → `delta`, `tool` e `approval` até
`turn.completed|failed` → `state` sem turno → `DELETE` ao trocar, ao pedir nova sessão ou ao
fechar.

## Possíveis erros

`Nenhum Workspace Server conectado expõe "<id>"`, `Mais de um Workspace Server expõe "<id>"`,
`Há um turno em andamento`, `turno falhou: <código>` (`turn_cancelled`, `turn_timeout`,
`agent_process_exited`, etc.), erros da Agent API como `<código>: <mensagem>`
(`invalid_agent_key`, `worker_unavailable`, `workspace_not_found`, `provider_unavailable`,
`agent_start_failed`) e `não foi possível registrar a decisão`.
