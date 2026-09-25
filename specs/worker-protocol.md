# Protocolo do worker e da ponte MCP

Contratos privados definidos pelo
[ADR-023](../adr/ADR-023-worker-remoto-e-isolamento-de-workspace.md). Versão do
protocolo: `1`.

## 1. Worker ↔ agentd

### Transporte e autenticação

- O `azigate-worker` (máquina B) abre `GET /worker/v1/connect` com upgrade WebSocket
  para o agentd (máquina A). Em produção, `wss://`; `ws://` só para `localhost`,
  `127.0.0.1` ou `::1`.
- Cabeçalho `Authorization: Bearer <token de worker>`. Token inválido, expirado ou sem
  `worker:connect` é recusado antes do upgrade com `401`.
- Frames de texto JSON; `maxPayload` de 8 MiB. Frame binário ou JSON inválido fecha a
  conexão com `1003`.

### Token de worker

`base64url(payload) + "." + base64url(HMAC-SHA256(WORKER_TOKEN_SECRET, base64url(payload)))`,
com payload:

```json
{ "v": 1, "sub": "devbox", "scopes": ["worker:connect", "workspace:backend"], "iat": 1790000000, "exp": 1797776000 }
```

Gerado por `npm run worker:token -- --worker devbox --workspace backend --days 90`.
A comparação da assinatura usa tempo constante.

### Registro

Primeiro frame do worker, em até 10 segundos:

```json
{
  "type": "worker.register",
  "protocolVersion": 1,
  "workerId": "devbox",
  "workerVersion": "1.0.0",
  "capabilities": ["filesystem", "git", "exec"],
  "workspaces": ["backend", "frontend"]
}
```

- `workerId` precisa ser igual ao `sub` do token.
- Workspaces fora dos escopos `workspace:<id>` são descartados; se nenhum sobrar, o
  registro é recusado.
- `exec` só aparece quando o worker tem `exec.enabled: true`.

Resposta:

```json
{ "type": "worker.registered", "workerId": "devbox", "workspaces": ["backend"], "heartbeatIntervalMs": 15000 }
```

ou `{ "type": "worker.rejected", "code": "…", "message": "…" }` seguido de fechamento
`4403`. Uma nova conexão com o mesmo `workerId` substitui a anterior, que é fechada com
`4409`. Quando o token expira, o agentd fecha a conexão com `4401`, mesmo que ela
esteja ativa; o worker reconecta e só volta se o arquivo do token tiver sido renovado.

### Heartbeat

O worker envia `{ "type": "worker.heartbeat" }` a cada `heartbeatIntervalMs`. Sem
heartbeat por 3 intervalos, o agentd fecha com `4408` e falha as chamadas pendentes com
`worker_unavailable`. O worker reconecta com backoff exponencial de 1 s até 60 s.

### RPC

Pedido (agentd → worker):

```json
{ "type": "rpc.request", "id": "rpc_…", "workspace": "backend", "method": "read_file", "params": { "path": "src/app.ts" } }
```

Resposta (worker → agentd):

```json
{ "type": "rpc.response", "id": "rpc_…", "ok": true, "result": { … } }
{ "type": "rpc.response", "id": "rpc_…", "ok": false, "error": { "code": "path_outside_workspace", "message": "…" } }
```

O agentd aplica timeout por chamada (execução: timeout pedido + 5 s; demais: 30 s).

### Métodos

Todo `path` é relativo à raiz do workspace. Absoluto, `~`, byte nulo ou alvo que,
depois de `realpath` e resolução de symlinks, sai da raiz recebe
`path_outside_workspace`.

| Método | Params | Resultado |
|---|---|---|
| `list_directory` | `path` (padrão `.`) | `entries[]` (`name`, `type`: `file`/`directory`/`symlink`/`other`, `size`), `truncated` (limite 1000) |
| `find_file` | `pattern` (glob com `*` e `?` sobre o nome), `path`, `maxResults` (≤ 500) | `paths[]`, `truncated` |
| `search` | `query` (literal, não regex), `path`, `maxResults` (≤ 500), `caseSensitive` | `matches[]` (`path`, `line`, `text` ≤ 300 caracteres), `truncated` |
| `read_file` | `path`, `offset` (linha inicial, base 1), `limit` (linhas) | `content`, `totalBytes`, `truncated` (limite 1 MiB) |
| `write_file` | `path`, `content` (≤ 4 MiB), `createDirectories` | `bytesWritten` |
| `edit_file` | `path`, `oldText`, `newText`, `replaceAll` | `replacements`; `conflict` se `oldText` não existir ou for ambíguo sem `replaceAll` |
| `mkdir` | `path` | `created` (recursivo) |
| `delete` | `path`, `recursive` | `deleted`; a raiz do workspace nunca pode ser removida |
| `git_status` | — | `output` (`git status --porcelain=v1 --branch`) |
| `git_diff` | `staged`, `path` | `output`, `truncated` |
| `git_log` | `maxCount` (≤ 200) | `output` |
| `shell_exec` | `argv[]`, `cwd`, `timeoutMs` (≤ 600000), `stdin` | `exitCode`, `signal`, `stdout`, `stderr`, `timedOut`, `truncated` |
| `process_start` | `argv[]`, `cwd` | `processId` |
| `process_stdin` | `processId`, `data`, `close` | `written` |
| `process_output` | `processId`, `cursor` | `output`, `cursor`, `running`, `exitCode` |
| `process_kill` | `processId`, `signal` (`SIGTERM`/`SIGKILL`/`SIGINT`) | `killed` |

Git roda com `-c core.fsmonitor=false`, `-c core.hooksPath=/dev/null`,
`-c diff.external=`, `--no-ext-diff`, `--no-textconv`, `GIT_TERMINAL_PROMPT=0`,
`GIT_OPTIONAL_LOCKS=0` e `GIT_CEILING_DIRECTORIES` apontando para o diretório pai da
raiz, para que a configuração do repositório não execute programas e o git nunca suba
para um repositório fora do workspace.

`write_file`, `edit_file`, `mkdir` e `delete` recusam com `permission_denied` qualquer
caminho que contenha um segmento `.git`: alterar `.git/config`, hooks ou
`info/attributes` permitiria programar execução de código num `git_status` posterior.
Leitura e escrita abrem arquivos com `O_NOFOLLOW` e `O_NONBLOCK` (um FIFO no workspace
não trava o worker); `delete` remove o link, nunca o alvo de um symlink.

`shell_exec` e `process_*` exigem `exec.enabled: true` (senão `exec_disabled`) e, se
`exec.allowedCommands` existir, `argv[0]` na lista (senão `command_not_allowed`).
Execução: `spawn` sem shell, ambiente mínimo, grupo de processos, saída limitada a
1 MiB por fluxo, no máximo 4 processos simultâneos (`process_limit`).

Códigos de erro: `invalid_params`, `method_not_found`, `workspace_not_found`,
`path_outside_workspace`, `not_found`, `already_exists`, `too_large`, `conflict`,
`exec_disabled`, `command_not_allowed`, `process_not_found`, `process_limit`,
`timeout`, `io_error`, `permission_denied` e, gerado pelo agentd,
`worker_unavailable`.

## 2. Ponte MCP ↔ agentd

Usada nas sessões `claude` com `worker`.

- O agentd escreve, em diretório `0700` da sessão, um `mcp-config.json` `0600` que
  inicia `azigate-mcp-bridge` por stdio com as variáveis `AZIGATE_MCP_SOCKET` e
  `AZIGATE_MCP_TOKEN` (token aleatório de 32 bytes, válido só enquanto a sessão existir).
- O Claude é iniciado com `--tools ""`, `--strict-mcp-config`,
  `--mcp-config <arquivo>` e `--allowedTools` com as ferramentas somente leitura.
- A ponte implementa MCP por stdio (JSON-RPC 2.0 delimitado por linha): `initialize`,
  `notifications/initialized`, `ping`, `tools/list` e `tools/call`.
- Ponte → agentd, pelo socket Unix `0600` `AZIGATE_MCP_SOCKET`, uma linha JSON por
  chamada: `{ "id": 1, "token": "…", "tool": "read_file", "arguments": { … } }`.
  Resposta: `{ "id": 1, "ok": true, "result": { … } }` ou
  `{ "id": 1, "ok": false, "error": { "code": "…", "message": "…" } }`.
- O agentd resolve o token para a sessão, aplica o modo de permissão (`plan` recusa
  escrita e execução com `permission_denied`) e encaminha ao worker e workspace da
  sessão. O token nunca aparece em argv, log ou evento.

Ferramentas MCP publicadas: as mesmas dos métodos RPC (nome idêntico) e com o mesmo
esquema de parâmetros. Somente leitura: `list_directory`, `find_file`, `search`,
`read_file`, `git_status`, `git_diff`, `git_log`.
