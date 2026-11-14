# Servidor e conexão (`azigate-workspace`)

## Descrição

Processo da máquina B. No modo padrão conecta **de saída** ao `azigate-agentd` da máquina A por
WebSocket, registra os workspaces autorizados e hospeda um canal MCP por sessão de agente. No
modo `--mcp-stdio`, serve um workspace por stdio a um cliente MCP local.

## Localização no código

- `src/workspace/server/main.ts` — entrypoint (`azigate-workspace` do
  [pacote da máquina B](client-package.md), ou `npm run start:workspace`; `start:worker` e
  `dist/worker/main.js` continuam como aliases).
- `src/workspace/server/config.ts` — arquivo JSON e flags.
- `src/workspace/server/connection.ts` — registro, heartbeat, canais MCP, RPC e reconexão.
- `src/workspace/server/handler.ts` — despacho por método para o workspace certo.
- `src/agent-control/workers.ts` — `WorkerHub`, o lado do agentd.

## Entrada

`--config <arquivo.json>` (sem ele, `workspace.json` da pasta local — `AZIGATE_CONFIG_DIR`,
`$XDG_CONFIG_HOME/azigate` ou `~/.config/azigate`, criada pelo `client:setup`) e, opcionalmente,
`--gateway`, `--worker`, `--token-file`, `--mcp-stdio` e `--workspace`:

```json
{
  "gateway": "https://ia.example.com",
  "workerId": "maquina-b",
  "tokenFile": "/home/user/.config/azigate/workspace.token",
  "workspaces": { "meu-projeto": { "path": "/home/user/projetos/meu-projeto" } },
  "exec": { "enabled": true, "allowedCommands": ["npm", "node", "git", "npx"] }
}
```

`gateway`, `workerId` e `tokenFile` não são necessários com `--mcp-stdio`.

## Saída

Logs JSON em **stderr** (stdout fica livre para o MCP no modo stdio), só com eventos e contagens:
`worker_registered`, `workspace_mcp_channel_opened`, `worker_disconnected`,
`worker_connect_refused`.

## Dependências

`ws` (embutido no pacote da máquina B); `git` no PATH para `git_*`; as toolchains do projeto
para execução.

## Regras de negócio

- Token só por arquivo `0600` (`--token` em argv é recusado); `wss://` obrigatório fora de
  loopback — em LAN, use túnel SSH para o agentd.
- Capacidades anunciadas: `filesystem`, `git`, `mcp` e, se `exec.enabled`, `exec`.
- Até 32 canais MCP simultâneos; canal para workspace não exposto é recusado.
- Reconexão com backoff de 1 s a 60 s; o token é relido do arquivo a cada tentativa.
- No modo `--mcp-stdio`, fechar o stdin encerra o processo depois de responder o que já foi
  recebido.

## Fluxo resumido

lê config e token → conecta com Bearer → `worker.register` → `worker.registered` → heartbeat →
atende `mcp.open`/`mcp.message` (um `WorkspaceMcpServer` por canal) e `rpc.request` →
reconecta se cair.

## Possíveis erros

Configuração inválida, token com permissão aberta ou vazio, URL sem TLS, `--workspace` ausente
no modo stdio. Conexão: HTTP `401`, fechamentos `4403`, `4408`, `4409` e `4401` (token expirou).
