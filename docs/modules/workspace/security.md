# Segurança do workspace

## Descrição

Controles que valem para qualquer agente que use o Workspace Server
([ADR-023](../../../adr/ADR-023-worker-remoto-e-isolamento-de-workspace.md),
[ADR-025](../../../adr/ADR-025-workspace-server-mcp-para-os-tres-agentes.md)).

## Localização no código

`src/workspace/security/jail.ts`, `src/workspace/security/token.ts`,
`src/workspace/filesystem/fs-ops.ts`, `src/workspace/git/git-ops.ts`,
`src/workspace/process/process-ops.ts`.

## Entrada

Caminhos relativos, argv, token de worker.

## Saída

Operação executada dentro da raiz ou erro (`path_outside_workspace`, `permission_denied`,
`exec_disabled`, `command_not_allowed`…).

## Dependências

`realpath` do sistema de arquivos, `git`.

## Regras de negócio

- O cliente da Agent API nunca informa caminho: só `workspace`; o caminho real existe apenas
  na configuração da máquina B.
- Jail: recusa absoluto, `~` e byte nulo; `realpath` do alvo (ou do ancestral existente) precisa
  ficar dentro da raiz; symlink para fora é recusado; `delete` remove o link, nunca o alvo; a
  raiz não pode ser removida.
- Qualquer alteração em caminho com segmento `.git` é recusada (`permission_denied`).
- `O_NOFOLLOW` e `O_NONBLOCK` ao abrir arquivos; limites de 1 MiB (leitura), 4 MiB (escrita),
  50 000 entradas por varredura.
- Git sem fsmonitor, hooks, diff externo e textconv, e com `GIT_CEILING_DIRECTORIES`.
- Execução desligada por padrão; ligada, só `argv` sem shell, allowlist opcional de `argv[0]`,
  ambiente mínimo, timeout, saída limitada e até 4 processos longos. Um programa permitido roda
  com os privilégios do usuário do Workspace Server: use um usuário dedicado.
- Token HMAC com `workerId`, escopos por workspace e expiração; conexão encerrada quando o
  token expira.

## Fluxo resumido

pedido → jail/validação → operação → resultado sem caminhos reais da máquina B.

## Possíveis erros

Ver [workspace-protocol.md](../../../specs/workspace-protocol.md#métodos).
