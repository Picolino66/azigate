# Worker remoto (`azigate-worker`)

## Descrição

Executável que roda na máquina do projeto (máquina B), conecta **de saída** ao agentd por
WebSocket e oferece operações de arquivo, Git e, opcionalmente, execução de programas
sobre workspaces declarados localmente ([ADR-023](../../../adr/ADR-023-worker-remoto-e-isolamento-de-workspace.md)).

## Localização no código

- `src/worker/main.ts` — entrypoint; `src/worker/config.ts` — arquivo e flags.
- `src/worker/client.ts` — conexão, registro, heartbeat, reconexão.
- `src/worker/handler.ts` — despacho por método.
- `src/worker/jail.ts`, `fs-ops.ts`, `git-ops.ts`, `process-ops.ts` — operações.
- `src/worker-protocol/` — mensagens, token e transporte.
- `src/agent-control/workers.ts` — `WorkerHub` do lado do agentd.
- `src/agentd/worker-token.ts` — `npm run worker:token`.

## Entrada

Configuração JSON (`--config`), com flags opcionais `--gateway`, `--worker` e
`--token-file`:

```json
{
  "gateway": "https://ia.example.com",
  "workerId": "devbox",
  "tokenFile": "/home/user/.config/azigate/worker.token",
  "workspaces": { "backend": { "path": "/home/user/projects/backend" } },
  "exec": { "enabled": false, "allowedCommands": ["npm", "git", "node"] }
}
```

## Saída

Respostas RPC descritas em [worker-protocol.md](../../../specs/worker-protocol.md); logs
JSON de conexão sem conteúdo.

## Dependências

`ws`, `git` no PATH (métodos `git_*`), toolchains do projeto (execução).

## Regras de negócio

- Token só por arquivo `0600` (`--token` em argv é recusado). O token limita `workerId` e
  workspaces; o agentd recusa registro de outro ID e descarta workspaces fora do escopo.
- `wss://` obrigatório fora de loopback.
- Jail: path relativo, sem `~`, absoluto ou byte nulo; `realpath` do alvo (ou do ancestral
  existente) precisa ficar dentro da raiz; symlink para fora é recusado; `delete` remove o
  link, nunca o alvo; a raiz não pode ser removida.
- Alterações em qualquer caminho com segmento `.git` são recusadas (`permission_denied`).
- Arquivos abertos com `O_NOFOLLOW` e `O_NONBLOCK`; leitura ≤ 1 MiB, escrita ≤ 4 MiB,
  busca literal (sem regex), varredura ≤ 50 000 entradas, `node_modules` e `.git`
  ignorados.
- Git endurecido: sem fsmonitor, hooks, diff externo e textconv; nunca sobe para um
  repositório acima da raiz.
- Execução desligada por padrão; quando ligada, `spawn` sem shell, argv explícito,
  allowlist opcional de `argv[0]`, cwd na jail, ambiente mínimo, grupo de processos,
  timeout, saída ≤ 1 MiB e até 4 processos longos. **Um programa permitido roda com os
  privilégios do usuário do worker**: use um usuário dedicado.

## Fluxo resumido

lê config e token → conecta com Bearer → `worker.register` → `worker.registered` →
heartbeat → atende `rpc.request` → reconecta com backoff (1 s → 60 s) se cair.

## Possíveis erros

Inicialização: configuração inválida, token com permissão aberta ou vazio, URL sem TLS.
Conexão: HTTP `401` (token), fechamentos `4403` (registro recusado), `4408` (sem
heartbeat), `4409` (substituído), `4401` (token expirou). RPC: códigos da
[especificação](../../../specs/worker-protocol.md#métodos).
