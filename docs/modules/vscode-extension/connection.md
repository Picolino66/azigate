# Conexão e workspaces

## Descrição

Resolve a URL e a chave do `azigate-agentd` e a lista de workspaces que o painel oferece,
pré-selecionando o workspace que contém a pasta aberta no VS Code.

## Localização no código

`src/vscode-extension/connection.ts` (`validateAgentUrl`, `resolveConnection`,
`loadLocalWorkspaces`, `workspaceForFolders`), `src/agent-client/settings.ts`
(`resolveAgentUrl`, `resolveClientSettings`) e os comandos de chave em
`src/vscode-extension/extension.ts`.

## Entrada

- Configuração de usuário `azigate.agentUrl` (escopo `machine`).
- Chave no SecretStorage do VS Code, gravada pelo comando **Azigate: Definir chave do agentd**
  (campo de senha) e apagada por **Azigate: Remover chave do agentd**.
- Arquivos do [`client:setup`](../workspace/client-package.md) em `~/.config/azigate`
  (`AZIGATE_CONFIG_DIR` e `XDG_CONFIG_HOME` são respeitados): `agent.json`, `agent.key` (`0600`)
  e `workspace.json`.
- Pastas abertas no VS Code, usadas só para pré-selecionar um ID.

## Saída

`{ url, key }` para a `AgentApi`, a lista de IDs de workspace (os do `workspace.json` mais os
expostos pelos workers conectados, em ordem alfabética) e o ID pré-selecionado.

## Dependências

`parseWorkspaces` (`src/agent-control/workspaces.ts`), `azigateConfigDir` e `readPrivateFile`
(`src/workspace/security/local-files.ts`).

## Regras de negócio

- URL: `azigate.agentUrl` → `AZIGATE_AGENT_URL` → `agent.json` → `http://127.0.0.1:3100`.
- A URL precisa ser `https://`. `http://` só é aceito em `localhost`, `127.0.0.1` ou `::1`. Não
  pode conter credenciais, query string nem fragmento.
- Chave: SecretStorage → `AZIGATE_AGENT_KEY_FILE` → `AZIGATE_AGENT_KEY` → `agent.key`. Com a
  chave no SecretStorage, o `agent.key` não é lido. Arquivos de chave precisam ser `0600`.
- A chave nunca vai para as configurações nem para o log. O canal de log mostra só o host do
  agentd.
- Mudar `azigate.agentUrl` ou a chave reconecta e encerra a sessão aberta.
- `workspace.json` ausente não é erro: o painel usa os workspaces dos workers conectados. JSON
  inválido aparece no log e deixa a lista local vazia.
- A pré-seleção escolhe o workspace cuja raiz real contém a pasta aberta, preferindo a raiz mais
  profunda. O caminho só é comparado localmente e nunca vai ao agentd.

## Fluxo resumido

Ativação → `loadLocalWorkspaces` + `workspaceForFolders` → `resolveConnection` → `AgentApi` →
`GET providers` e `workers` → estado do painel.

## Possíveis erros

`A URL do agentd deve usar https:// (http:// só em loopback)`, `A URL do agentd não pode conter
credenciais, query string ou fragmento`, `A URL do agentd é inválida`, `Chave do agentd ausente`,
`O arquivo da chave precisa ter permissão 0600`, `<caminho>: JSON inválido ou inacessível` e os
erros de `parseWorkspaces` (ID inválido, caminho relativo, diretório inexistente).
