# Pacote da máquina B (`azigate-client`) e `client:setup`

## Descrição

A máquina do projeto (B) não precisa do repositório do Azigate. Ela instala um pacote pequeno,
`azigate-client`, com dois programas em arquivo único e sem dependências (o `ws` vai embutido):

- `azigate-workspace` — o [Workspace Server](server.md);
- `azigate-agent` — o [cliente de terminal](../agents/agent-client.md).

A configuração vem pronta da máquina A: `npm run -s client:setup` imprime um bloco de shell que,
colado na B, cria `~/.config/azigate` com tudo o que os dois programas leem sem flags.

## Localização no código

- `tools/client-package.ts` — bundle com esbuild (`buildClientPackage`) e `npm pack`
  (`packClient`); `tools/build-client.ts` é o entrypoint de `npm run pack:client`.
- `src/agentd/client-setup.ts` — `parseClientSetupArgs` e `buildClientSetupScript`;
  `src/agentd/client-setup-cli.ts` é o entrypoint de `npm run client:setup`.
- `src/workspace/security/local-files.ts` — `azigateConfigDir` e `readPrivateFile`.
- `src/agent-client/settings.ts` — `resolveClientSettings`.

## Entrada

- `npm run pack:client [-- <pasta>]` (padrão `dist-client/`).
- `npm run -s client:setup -- --worker <id> --workspace <id>=<caminho absoluto na B>
  [--workspace …] [--gateway <url>] [--exec npm,npx,node,git] [--days 90] [--with-agent-key]`.
  Lê `WORKER_TOKEN_SECRET` (e, com `--with-agent-key`, a primeira chave de `AGENT_API_KEYS`)
  do `.env` da máquina A.

## Saída

- `dist-client/azigate-client-<versão>.tgz`, instalável com `npm install -g <arquivo>`.
- Bloco de shell com `workspace.token`, `workspace.json`, `agent.json` e, opcionalmente,
  `agent.key`. **Contém segredos**: copie direto para o terminal da B e não o salve em log.

## Dependências

esbuild (devDependency, só na máquina A); Node.js `>=20.18.1` e `git` na máquina B.

## Regras de negócio

- O pacote contém só código da máquina B: nada do Model Plane nem do agentd. É `private`
  (não vai para o registro do npm).
- O bloco roda num subshell com `umask 077`: pasta `0700`, arquivos `0600`, e o umask de quem
  colou não muda. Usa `AZIGATE_CONFIG_DIR`, senão `$XDG_CONFIG_HOME/azigate`, senão
  `~/.config/azigate`.
- Os caminhos dos workspaces são da máquina B e precisam ser absolutos; o Workspace Server
  confere que existem ao iniciar. A URL segue a mesma regra do Workspace Server (`wss://` fora
  de loopback).
- Sem `--exec`, a execução de programas fica desligada. Sem `--with-agent-key`, a chave do
  agentd fica fora do bloco (use `AZIGATE_AGENT_KEY` na B).
- `azigate-workspace` sem `--config` lê `workspace.json` da pasta local. `azigate-agent` usa
  `AZIGATE_AGENT_URL` → `agent.json` → `http://127.0.0.1:3100`, e `AZIGATE_AGENT_KEY_FILE` →
  `AZIGATE_AGENT_KEY` → `agent.key`. Arquivos de chave e token precisam ser `0600`.

## Fluxo resumido

A: `npm run pack:client` → copia o `.tgz` para a B → B: `npm install -g azigate-client-*.tgz`.
A: `npm run -s client:setup -- …` → cola o bloco na B → B: `azigate-workspace` e
`azigate-agent chat claude meu-projeto`.

## Possíveis erros

`client:setup`: argumento inválido, caminho relativo, URL sem TLS fora de loopback, `--exec`
com algo que não é nome de programa, `WORKER_TOKEN_SECRET` ou `AGENT_API_KEYS` ausentes.
Na B: `O arquivo da chave precisa ter permissão 0600`, `agent.json: JSON inválido`, workspace
inexistente.
