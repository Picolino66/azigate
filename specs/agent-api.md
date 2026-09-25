# Especificação funcional do Agent Plane (`azigate-agentd`)

Contrato do serviço de agentes nativos definido pelo
[ADR-022](../adr/ADR-022-agent-plane-nativo.md). Este contrato **não é
OpenAI-compatible** e não substitui o [contrato do Model Plane](./gateway-api.md).
OpenAPI: [agent-openapi.yaml](./agent-openapi.yaml). Protocolo do worker:
[worker-protocol.md](./worker-protocol.md).

## Rotas

| Método | Caminho | Autenticação | Resultado |
|---|---|---|---|
| GET | `/health` | não | liveness do agentd |
| GET | `/ready` | não | banco acessível e ao menos um provider disponível |
| GET | `/agent/v1/providers` | Bearer agente | instalação, autenticação, versão e certificação por provider |
| GET | `/agent/v1/workers` | Bearer agente | workers conectados e seus workspaces |
| POST | `/agent/v1/sessions` | Bearer agente | cria sessão e inicia o processo nativo |
| GET | `/agent/v1/sessions/:id` | Bearer agente | estado da sessão, turno atual e aprovações pendentes |
| POST | `/agent/v1/sessions/:id/turns` | Bearer agente | inicia um turno (assíncrono) |
| GET | `/agent/v1/sessions/:id/events` | Bearer agente | SSE de eventos universais com `native` |
| POST | `/agent/v1/sessions/:id/cancel` | Bearer agente | interrompe o turno em andamento |
| DELETE | `/agent/v1/sessions/:id` | Bearer agente | encerra a sessão e o processo |
| POST | `/agent/v1/approvals/:id` | Bearer agente | decide uma aprovação pendente |
| WS | `/native/:provider/:sessionId` | Bearer agente | eventos nativos da sessão, somente saída |
| WS | `/worker/v1/connect` | Bearer worker | canal do `azigate-worker` (ver protocolo) |

Qualquer outro caminho recebe `404 route_not_found`. "Bearer agente" aceita somente
`AGENT_API_KEYS`; chaves do Model Plane (`GATEWAY_API_KEYS`) e tokens de worker são
recusados com `401 invalid_agent_key`. `AGENT_ALLOWED_IPS` e rate limit local
(`AGENT_RATE_LIMIT_*`) valem para todas as rotas autenticadas.

## Erros

Formato único:

```json
{ "error": { "message": "texto em português", "type": "agent_error", "code": "codigo_estavel" } }
```

Mensagens nunca contêm prompt, saída de ferramenta, path real, stderr da CLI ou segredo.

## Isolamento por credencial

Cada sessão guarda o identificador (digest truncado) da chave que a criou. Outra chave
recebe `404 session_not_found` para a sessão e `404 approval_not_found` para suas
aprovações, sem revelar a existência do recurso.

## Providers

| `provider` | Sinônimo aceito | Interface nativa | Sessão nativa | Worker remoto |
|---|---|---|---|---|
| `codex` | `codex-agent` | `codex app-server` (JSON-RPC stdio) | `threadId` | não (ADR-023) |
| `claude` | `claude-agent` | `claude -p` `stream-json` + controle | `session_id` | sim, via MCP |
| `agy` | `agy-agent` | `agy` `stream-json` | `conversation_id` | não (ADR-023) |

Os aliases `codex-cli-*`/`claude-cli-*` pertencem ao Model Plane (model adapters) e não
são aceitos aqui.

### `GET /agent/v1/providers`

```json
{
  "codex": {
    "enabled": true,
    "installed": true,
    "authenticated": true,
    "version": "0.144.6",
    "certified": true,
    "available": true,
    "adapterVersion": "1",
    "protocol": "codex-app-server-v2",
    "remoteWorkspace": false
  }
}
```

`authenticated` é `null` quando a verificação não foi possível. `available` indica se o
provider aceita sessões: habilitado, instalado e, com `AGENT_VERSION_POLICY=fail-closed`,
certificado. O resultado fica em cache por 60 segundos.

## Sessões

### `POST /agent/v1/sessions`

Corpo (campos desconhecidos são recusados):

| Campo | Tipo | Regra |
|---|---|---|
| `provider` | string | obrigatório; tabela acima |
| `workspace` | string | obrigatório; `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` |
| `worker` | string | opcional; mesmo formato; ausente = workspace local do host A |
| `model` | string | opcional; `^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$`; ausente = padrão da CLI |
| `effort` | string | opcional; Codex `low`,`medium`,`high`,`xhigh`; Claude `low`,`medium`,`high`,`xhigh`,`max`; AGY `low`,`medium`,`high` |
| `permissionMode` | string | opcional; `review` (padrão), `acceptEdits`, `plan` |

Resposta `201`:

```json
{
  "id": "agt_5f0c9e1b7a2d4c6e8f10a2b4",
  "provider": "claude",
  "status": "ready",
  "nativeSessionId": "3b6a1f5e-6c1d-4a8b-9e0f-2d7c4b1a9e33",
  "workspace": "backend",
  "worker": null,
  "model": "sonnet",
  "effort": null,
  "permissionMode": "review",
  "providerVersion": "2.1.280",
  "adapterVersion": "1",
  "protocolVersion": "claude-stream-json-v1",
  "createdAt": "2026-09-25T12:00:00.000Z",
  "updatedAt": "2026-09-25T12:00:01.000Z",
  "currentTurn": null,
  "pendingApprovals": []
}
```

`nativeSessionId` pode ser `null` até o provider informá-lo.

Erros: `400 invalid_request`, `400 invalid_provider`, `400 invalid_effort`,
`400 worker_not_supported_for_provider`, `404 workspace_not_found`,
`503 worker_unavailable`, `503 provider_unavailable`, `429 agent_session_limit`,
`502 agent_start_failed`.

### Estados

| Status | Significado |
|---|---|
| `starting` | processo nativo iniciando |
| `ready` | processo vivo e ocioso |
| `running` | turno em andamento |
| `suspended` | sem processo (ociosidade, cancelamento, crash ou reinício do agentd); o próximo turno retoma pela sessão nativa |
| `failed` | não pode ser retomada (sem sessão nativa ou falha de início) |
| `closed` | encerrada pelo cliente |

Somente `starting`, `ready` e `running` contam para `AGENT_MAX_SESSIONS` e
`AGENT_MAX_SESSIONS_PER_PROVIDER`. Após `AGENT_SESSION_IDLE_TIMEOUT` sem atividade, o
processo é encerrado e a sessão vira `suspended`.

### `POST /agent/v1/sessions/:id/turns`

Corpo: `{ "input": "texto" }`, com 1 a `AGENT_MAX_INPUT_CHARS` caracteres.

Resposta `202`: `{ "sessionId": "agt_…", "turnId": "trn_…", "status": "running" }`.
O resultado chega pelos eventos. Sessão `suspended` é retomada antes do turno
(`codex`: `thread/resume`; `claude`: `--resume`; `agy`: `--conversation`).

Erros: `404 session_not_found`, `409 session_closed`, `409 session_failed`,
`409 turn_in_progress`, `429 agent_session_limit`, `502 agent_start_failed`,
`503 worker_unavailable`.

Um turno que excede `AGENT_TURN_TIMEOUT` é interrompido e termina em `turn.failed` com
`turn_timeout`.

### `POST /agent/v1/sessions/:id/cancel`

`202 { "sessionId", "turnId", "status": "cancelling" }`. O turno termina com
`turn.failed` e `error.code = "turn_cancelled"`. Claude recebe `control_request`
`interrupt`; Codex recebe `turn/interrupt`; AGY (sem controle de entrada) recebe
`SIGINT` no grupo de processos, a sessão vira `suspended` e o próximo turno retoma a
conversa. Erro: `409 no_turn_in_progress`.

### `DELETE /agent/v1/sessions/:id`

Encerra o processo, nega aprovações pendentes, emite `session.closed` e responde `200`
com a sessão `closed`. Repetir a chamada responde `200` com o mesmo estado.

## Eventos

`GET /agent/v1/sessions/:id/events` responde `text/event-stream`:

```text
id: 12
event: tool.started
data: {"id":12,"event":"tool.started","sessionId":"agt_…","provider":"agy","turnId":"trn_…","timestamp":"…","tool":"run_command","toolCallId":"…","native":{…}}
```

- Replay a partir de `Last-Event-ID` ou `?after=<id>`; sem eles, o stream começa pelo
  buffer disponível. O buffer guarda os últimos `AGENT_EVENT_BUFFER` eventos da sessão,
  somente em memória; eventos mais antigos são perdidos (o cliente detecta pela
  lacuna de `id`).
- O primeiro bloco é o comentário `: conectado`, que descarrega os cabeçalhos mesmo
  sem eventos no buffer; depois, `: keep-alive` a cada 15 segundos.
- Com a sessão `closed`, o stream envia o buffer restante e encerra.

Tipos universais:

| `event` | Campos adicionais |
|---|---|
| `session.started` | `nativeSessionId`, `model` |
| `turn.started` | — |
| `message.delta` | `text` |
| `reasoning.delta` | `text` |
| `tool.started` | `tool`, `toolCallId` |
| `tool.completed` | `tool`, `toolCallId`, `status` (`completed`, `failed`, `declined`) |
| `approval.required` | `approvalId`, `tool`, `summary` |
| `approval.resolved` | `approvalId`, `tool`, `decision` (`allow`, `deny`), `reason` (`client`, `timeout`, `session_closed`, `cancelled`) |
| `subagent.started` | `toolCallId`, `nativeSessionId` quando conhecido |
| `subagent.completed` | `toolCallId`, `status` |
| `usage` | `usage`: `inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningTokens`, `totalTokens`, `costUsd` (cada um opcional) |
| `turn.completed` | `output` (texto final, quando o provider informa) |
| `turn.failed` | `error`: `{ code, message }` |
| `session.closed` | — |
| `provider.event` | apenas `native` |

Todo evento derivado de uma mensagem da CLI inclui `native` com a mensagem original.
Eventos gerados pelo agentd (`turn.started`, `approval.resolved`, falhas de processo,
`session.closed`) não têm `native`.

Códigos de `turn.failed`: `turn_cancelled`, `turn_timeout`, `agent_process_exited`,
`agent_protocol_error`, `agent_turn_failed`, `approval_lost`.

## Aprovações

Objeto:

```json
{
  "id": "apr_0c1d2e3f4a5b6c7d8e9f0a1b",
  "sessionId": "agt_…",
  "turnId": "trn_…",
  "provider": "claude",
  "tool": "mcp__azigate_workspace__shell_exec",
  "summary": "npm install package-x",
  "status": "pending",
  "createdAt": "…",
  "resolvedAt": null
}
```

`POST /agent/v1/approvals/:id` com `{ "decision": "allow" | "deny" }` responde `200` com a
aprovação resolvida. Erros: `400 invalid_decision`, `404 approval_not_found`,
`409 approval_already_resolved`. Aprovação não decidida em `AGENT_APPROVAL_TIMEOUT`
expira como negação. Quando o próprio agente desiste do pedido (Claude `control_cancel_request`), o turno termina ou é cancelado, a aprovação vira `cancelled` e também nega. `summary` é truncado em 500 caracteres. Aprovações ficam só em memória.

Mapeamento nativo:

| Provider | Pedido nativo | `allow` | `deny` |
|---|---|---|---|
| Claude | `control_request` `can_use_tool` | `{"behavior":"allow","updatedInput":<input original>}` | `{"behavior":"deny","message":…}` |
| Codex | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` | `accept` | `decline` |
| Codex | `item/permissions/requestApproval` | concede o perfil pedido no escopo `turn` | perfil vazio no escopo `turn` |
| Codex | `execCommandApproval`, `applyPatchApproval` (legados) | `approved` | `denied` |
| AGY | não existe canal headless | — | a CLI nega o que exigiria revisão |

Outras requisições do app-server do Codex (`item/tool/requestUserInput`,
`mcpServer/elicitation/request`, `item/tool/call`, `account/chatgptAuthTokens/refresh`,
`attestation/generate`) recebem erro JSON-RPC `-32601`.

## Modos de permissão

| `permissionMode` | Codex | Claude | AGY |
|---|---|---|---|
| `review` | `approvalPolicy: untrusted`, `sandbox: workspace-write` | `--permission-mode manual` + aprovação do Azigate | modo padrão (`request-review`) |
| `acceptEdits` | `approvalPolicy: on-request`, `sandbox: workspace-write` | `--permission-mode acceptEdits` | `--mode accept-edits` |
| `plan` | `approvalPolicy: untrusted`, `sandbox: read-only` | `--permission-mode plan` | `--mode plan` |

## Endpoint nativo

`WS /native/:provider/:sessionId` envia, para cada evento com `native`, um frame texto
`{"id":…,"event":…,"native":…}`. O provider do caminho precisa coincidir com o da
sessão. Mensagens do cliente são ignoradas: o endpoint nunca repassa comandos à CLI.
Credencial inválida é recusada com HTTP `401` antes do upgrade. Fechamentos:
`4404` sessão inexistente, de outra credencial ou de outro provider; `1000` sessão
encerrada. O stream começa pelo buffer disponível da sessão.

## Configuração relevante

Ver [README](../README.md#agent-plane-azigate-agentd) e [.env.example](../.env.example).
