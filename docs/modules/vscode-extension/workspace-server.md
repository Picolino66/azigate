# Workspace Server local

## Descrição

Inicia e para o [`azigate-workspace`](../workspace/server.md) da máquina B a partir do painel ou
dos comandos, e mostra se o agentd já vê um Workspace Server que expõe o workspace escolhido,
seja ele iniciado pela extensão ou num terminal.

## Localização no código

`src/vscode-extension/workspace-process.ts` (`WorkspaceServerProcess`,
`validateServerCommand`, `minimalEnv`) e `src/vscode-extension/extension.ts`.

## Entrada

Botão **Iniciar**/**Parar** do painel, comandos **Azigate: Iniciar Workspace Server** e
**Azigate: Parar Workspace Server**, configurações `azigate.workspaceServer.command` (padrão
`azigate-workspace`) e `azigate.workspaceServer.autoStart` (padrão `false`), ambas com escopo
`machine`.

## Saída

Estado `stopped`, `starting`, `running` ou `failed` (com detalhe) no painel. A saída do processo
vai, linha a linha, para o canal de saída **Azigate** (até 2000 caracteres por linha).

## Dependências

Pacote [`azigate-client`](../workspace/client-package.md) instalado e `workspace.json` do
`client:setup`, que o `azigate-workspace` lê sem flags.

## Regras de negócio

- `spawn` sem shell e **sem argumentos**. Toda a configuração vem do `workspace.json`.
- O comando é um nome simples (`[A-Za-z0-9._-]`, resolvido pelo `PATH`) ou um caminho absoluto.
  Espaços, argumentos, `;` e valores começando com `-` são recusados.
- Ambiente mínimo por allowlist: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TMPDIR`,
  `XDG_CONFIG_HOME`, `AZIGATE_CONFIG_DIR`, `NODE_EXTRA_CA_CERTS` e, no Windows, `SystemRoot`,
  `USERPROFILE` e `APPDATA`. Outras variáveis do editor (tokens, chaves) não são repassadas.
- Grupo de processos próprio (fora do Windows). **Parar** manda SIGTERM ao grupo e SIGKILL 5 s
  depois. Desativar a extensão também para o processo.
- `autoStart` só inicia quando o `workspace.json` existe.
- Uma segunda chamada de iniciar com o processo de pé não faz nada.
- O indicador "conectado (worker)" vem do `GET /agent/v1/workers` do agentd, não do processo
  local.
- O Workspace Server continua com suas próprias garantias (jail por `realpath`, `.git`
  protegido, execução desligada por padrão). A extensão não as altera.

## Fluxo resumido

**Iniciar** → `validateServerCommand` → `spawn` → `starting` → evento `spawn` → `running` → o
agentd registra o worker → o painel mostra o worker conectado. **Parar** → SIGTERM → `exit` →
`stopped`.

## Possíveis erros

`"azigate-workspace" não encontrado; instale o azigate-client` (`ENOENT`), `encerrou (código N)`
ou `encerrou (SIGNAL)` quando o processo cai sozinho (por exemplo, `workspace.json` ou token
inválido; o motivo aparece no canal de log) e `O comando do Workspace Server deve ser um nome de
programa ou um caminho absoluto, sem argumentos`.
