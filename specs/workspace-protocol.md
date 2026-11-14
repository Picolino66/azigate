# Protocolo do Workspace Server e da ponte MCP

Contratos privados definidos pelo
[ADR-023](../adr/ADR-023-worker-remoto-e-isolamento-de-workspace.md) e pelo
[ADR-025](../adr/ADR-025-workspace-server-mcp-para-os-tres-agentes.md). Versão do
protocolo: `1` (os canais MCP são negociados pela capacidade `mcp`).

O **Workspace Server** (`azigate-workspace`, antigo `azigate-worker`; o nome "worker" continua
nas mensagens e na Agent API por compatibilidade) roda na máquina do projeto. Ele não chama
modelo nem decide nada: expõe o ambiente do workspace por MCP.

```text
Agente (A) ─stdio MCP─► azigate-mcp-bridge (A) ─socket Unix 0600─► relay do agentd (A)
                                                                          │ WS de saída (canal MCP)
                                                                          ▼
                                                       azigate-workspace (B) = servidor MCP ─► projeto
```

## 1. Workspace Server ↔ agentd

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
  "capabilities": ["filesystem", "git", "exec", "mcp"],
  "workspaces": ["backend", "frontend"]
}
```

- `workerId` precisa ser igual ao `sub` do token.
- Workspaces fora dos escopos `workspace:<id>` são descartados; se nenhum sobrar, o
  registro é recusado.
- `exec` só aparece quando o worker tem `exec.enabled: true`; `mcp` indica suporte aos canais
  MCP e é obrigatório para sessões de agente (sem ele: `503 worker_unavailable`).

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

### Canais MCP

Cada sessão de agente com workspace remoto usa um canal. O agentd abre com
`{ "type": "mcp.open", "channel": "mcp_…", "workspace": "meu-projeto" }` e depois envia
`{ "type": "mcp.message", "channel", "message": <JSON-RPC> }`; o Workspace Server cria um
servidor MCP preso àquele workspace e responde com `mcp.message` no mesmo canal.
`mcp.close` (agentd) e `mcp.closed` (worker) encerram o canal. Canal para workspace não
exposto, ou além de 32 simultâneos, recebe `mcp.closed` imediatamente. Queda da conexão fecha
todos os canais.

Servidor MCP do workspace: `initialize` (protocolos `2025-06-18`, `2025-03-26`,
`2024-11-05`), `notifications/initialized`, `ping`, `server/discover` (enviado pelo AGY antes do
`initialize`; responde `{}`), `tools/list` e `tools/call`. As ferramentas têm os nomes dos
métodos abaixo e trazem `annotations` (`readOnlyHint`, `destructiveHint`, `openWorldHint`).
Erro de ferramenta volta como resultado `isError: true` com `"<código>: <mensagem>"`.

### RPC

RPC tipado continua disponível para o próprio agentd. Pedido (agentd → worker):

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

## 2. Ponte MCP ↔ relay do agentd

- O agentd grava, no diretório `0700` da sessão, `mcp-session.json` (`0600`) com
  `{ "socket": "<AGENT_MCP_SOCKET>", "token": "<32 bytes aleatórios>" }`. A configuração MCP
  entregue ao agente contém só o comando da ponte e a variável `AZIGATE_MCP_SESSION` com o
  caminho desse arquivo — nunca o token.
- Como cada agente inicia a ponte:

  | Agente | Mecanismo nativo |
  |---|---|
  | Claude | `--mcp-config <sessão>/claude-mcp-config.json` + `--strict-mcp-config` |
  | Codex | `-c mcp_servers.azigate_workspace.{command,args,env}` no `codex app-server` |
  | AGY | servidor global `azigate_workspace` (`agy mcp add`) que herda `AZIGATE_MCP_SESSION` do processo `agy` |

- A ponte (`azigate-mcp-bridge`) é um cano: conecta no socket Unix `0600`, envia
  `{ "type": "hello", "token": "…" }` e depois repassa as linhas JSON-RPC nos dois sentidos.
  Arquivo de sessão com permissão aberta → sai com código 2. Sem `AZIGATE_MCP_SESSION`, a ponte
  responde como um servidor MCP sem ferramentas (uso do AGY fora do Azigate).
- O relay responde `{ "type": "error", "code": "permission_denied" | "worker_unavailable" |
  "workspace_not_found" }` e fecha quando o token é inválido/revogado ou o workspace não está
  disponível. Senão abre o canal MCP e aplica a política em `tools/call`:

  | Situação | Resultado |
  |---|---|
  | ferramenta somente leitura | repassa |
  | modo `plan` e ferramenta de escrita/execução | `permission_denied`, sem chegar a B |
  | Claude (aprovação nativa por `can_use_tool`) | repassa |
  | Codex/AGY, `acceptEdits`, escrita de arquivo | repassa |
  | Codex/AGY, demais escritas e execução | aprovação do Azigate; negada → `permission_denied` |

- O token é revogado quando o processo do agente termina ou a sessão fecha; conexões abertas
  com ele são derrubadas.

## 3. Modo MCP por stdio

`azigate-workspace --config <arquivo> --mcp-stdio --workspace <id>` serve um workspace por
stdio a qualquer cliente MCP da própria máquina B, sem gateway, token nem rede. Os logs vão
para stderr. A política de execução (`exec`) do arquivo continua valendo; aprovações ficam a
cargo do cliente MCP.
