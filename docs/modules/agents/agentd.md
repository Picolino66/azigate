# Serviço `azigate-agentd`

## Descrição

Processo separado do gateway de modelos que hospeda o Agent Plane. Roda no host A (fora
de container, para usar o login das CLIs do operador), escuta em `127.0.0.1:3100` por
padrão e fica atrás do Nginx.

## Localização no código

- `src/agentd/server.ts` — entrypoint; exige Node.js ≥ 22.13; desligamento gracioso.
- `src/agentd/config.ts` — `loadAgentdConfig`, validação de variáveis.
- `src/agentd/app.ts` — `createAgentdApp`: Fastify, WebSocket, autenticação, rate limit,
  erro padronizado, registry, `SessionService`, `WorkerHub` e socket MCP.
- `src/agentd/routes/` — `meta.ts`, `sessions.ts`, `native.ts`, `worker.ts`.

## Entrada

Variáveis de ambiente (ver [.env.example](../../../.env.example)):

| Variável | Padrão | Regra |
|---|---|---|
| `AGENT_GATEWAY_ENABLED` | `false` | precisa ser `true`, senão o processo não sobe |
| `AGENT_API_KEYS` / `_FILE` | — | obrigatória; cada chave ≥ 16 caracteres; nenhuma pode repetir `GATEWAY_API_KEYS` |
| `AGENT_HOST`, `AGENT_PORT` | `127.0.0.1`, `3100` | |
| `AGENT_ALLOWED_IPS`, `AGENT_TRUST_PROXY` | vazio, `false` | atrás do Nginx no mesmo host, use `AGENT_TRUST_PROXY=true` para a allowlist ver o IP real |
| `AGENT_RATE_LIMIT_MAX`, `AGENT_RATE_LIMIT_IP_MAX`, `AGENT_RATE_LIMIT_WINDOW_MS` | `120`, `120`, `60000` | local ao processo |
| `AGENT_MAX_REQUEST_BODY_BYTES` | `1048576` | |
| `AGENT_DATA_DIR` | `data/agentd` | banco, socket MCP e diretórios de sessão (`0700`) |
| `AGENT_WORKSPACES_FILE` | — | JSON `{"workspaces": {"id": {"path": "/abs"}}}` com os workspaces locais do host A |
| `CODEX_AGENT_ENABLED`, `CLAUDE_AGENT_ENABLED`, `AGY_AGENT_ENABLED` | `false` | |
| `CODEX_BINARY`, `CLAUDE_BINARY`, `AGY_BINARY` | `codex`, `claude`, `agy` | nome de comando ou caminho absoluto |
| `AGENT_VERSION_POLICY` | `fail-closed` em produção, `warn` fora | |
| `AGENT_MAX_SESSIONS`, `AGENT_MAX_SESSIONS_PER_PROVIDER` | `10`, `4` | contam só sessões com processo vivo |
| `AGENT_SESSION_IDLE_TIMEOUT`, `AGENT_TURN_TIMEOUT`, `AGENT_APPROVAL_TIMEOUT` | `30m`, `60m`, `10m` | durações `ms`/`s`/`m`/`h` |
| `AGENT_EVENT_BUFFER`, `AGENT_EVENT_BUFFER_BYTES`, `AGENT_MAX_INPUT_CHARS` | `2000`, `16 MiB`, `100000` | |
| `WORKER_ENABLED`, `WORKER_TOKEN_SECRET` / `_FILE`, `WORKER_HEARTBEAT_INTERVAL` | `false`, —, `15s` | segredo ≥ 32 caracteres, distinto das chaves |
| `AGENT_MCP_SOCKET` | `<AGENT_DATA_DIR>/mcp.sock` | socket Unix `0600` da ponte MCP |

## Saída

Rotas descritas em [agent-api.md](../../../specs/agent-api.md). Logs estruturados (pino)
com `requestId`, método, template da rota, status, duração, `credentialId` ou `workerId`
e eventos de diagnóstico (`agent_session_created`, `agent_turn_timeout`,
`worker_registered`…), sempre sem conteúdo.

## Dependências

Fastify, `@fastify/websocket`/`ws`, `node:sqlite`, pino; as CLIs instaladas no host;
`GatewayAuthenticator` e `FixedWindowRateLimiter` reaproveitados do Model Plane.

## Regras de negócio

- Nenhuma rota do Model Plane existe aqui, e nenhuma rota do Agent Plane existe no
  `azigate`.
- Três credenciais disjuntas: `GATEWAY_API_KEYS` (Model Plane), `AGENT_API_KEYS`
  (Agent Plane) e tokens de worker (assinados por `WORKER_TOKEN_SECRET`).
- Recursos pertencem à chave que os criou; outra chave recebe `404`.
- `/health` e `/ready` são públicos; `/ready` exige banco acessível e ao menos um
  provider disponível.
- No startup: sessões ativas antes do reinício viram `suspended` (ou `failed` sem sessão
  nativa) e a matriz de versões é checada na primeira consulta de status.

## Fluxo resumido

`loadAgentdConfig` → abre SQLite → monta registry com os providers habilitados → cria
`WorkerHub` e socket MCP se `WORKER_ENABLED` → recupera sessões → registra rotas →
`listen`. No `SIGTERM`, encerra processos das CLIs (sessões ficam `suspended`), workers,
socket e banco.

## Possíveis erros

- Inicialização: variável ausente/inválida, credenciais repetidas, Node.js < 22.13,
  arquivo de workspaces inválido, `AGENT_MCP_SOCKET` apontando para arquivo que não é
  socket.
- HTTP: `401 invalid_agent_key`, `401 invalid_worker_token`, `403 ip_not_allowed`,
  `429 rate_limit_exceeded`, `413 request_body_too_large`, `400 invalid_json`,
  `415 unsupported_media_type`, `404 route_not_found`, `500 internal_error`.
