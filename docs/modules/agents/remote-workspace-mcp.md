# Workspace remoto via MCP (Claude + worker)

## Descrição

Permite uma sessão Claude na máquina A trabalhar no projeto da máquina B. O Claude
continua completo (raciocínio, subagentes, sessão), mas **sem nenhuma ferramenta
embutida**: arquivos, Git e execução chegam como ferramentas MCP que o Azigate encaminha
ao worker.

```text
Claude Code (A) ──stdio MCP──► azigate-mcp-bridge (A) ──socket Unix 0600──► agentd (A)
                                                                               │ WS
                                                                               ▼
                                                                     azigate-worker (B) ──► projeto
```

## Localização no código

- `src/agent-control/sessions.ts` — `workspaceTarget` (token, `mcp-config.json`).
- `src/agent-control/remote-tools.ts` — `RemoteToolGateway` (token → sessão/worker/modo).
- `src/agentd/mcp-socket.ts` — servidor do socket Unix.
- `src/agentd/mcp-bridge-launch.ts` — comando que o Claude usa para iniciar a ponte.
- `src/mcp-bridge/` — servidor MCP stdio e cliente do socket.

## Entrada

`POST /agent/v1/sessions` com `provider: "claude"`, `worker` e `workspace` publicados
pelo worker.

## Saída

Ferramentas `mcp__azigate_workspace__<método>` para o Claude; resultados de texto (conteúdo
de arquivo, saída de Git ou JSON).

## Dependências

`WORKER_ENABLED=true`, worker conectado com o workspace, build em `dist/` (ou `tsx` em
desenvolvimento) para iniciar a ponte.

## Regras de negócio

- Argv do Claude: `--tools ""` (nenhuma ferramenta do host A), `--strict-mcp-config`
  (ignora MCP do usuário), `--mcp-config <arquivo>` e `--allowedTools` com
  `list_directory`, `find_file`, `search`, `read_file`, `git_status`, `git_diff` e
  `git_log`. Escrita e execução passam pela aprovação do Azigate via `can_use_tool`.
- O cwd do Claude é o diretório privado da sessão (`0700`), vazio: nada do host A é
  exposto como projeto.
- Token de capacidade aleatório (32 bytes) por processo, só no `mcp-config.json` `0600`
  e no ambiente da ponte; revogado quando o processo termina ou a sessão fecha.
- O agentd reaplica o modo: `plan` só permite métodos somente leitura, mesmo que o
  agente tente outro.
- O socket Unix é criado com `umask 0177` e `chmod 0600`.

## Fluxo resumido

criar sessão → verifica worker/workspace → token + `mcp-config.json` → Claude inicia a
ponte → `tools/call` → socket → token válido? modo permite? → `WorkerHub.call` → worker →
resposta.

## Possíveis erros

`503 worker_unavailable`, `404 workspace_not_found`,
`400 worker_not_supported_for_provider` (Codex/AGY). Na ferramenta: `permission_denied`
(token inválido/revogado ou modo `plan`), `method_not_found`, `worker_unavailable`,
`timeout` e os códigos do worker.
