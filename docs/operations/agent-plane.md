# Tutorial: agentes na máquina A, projeto na máquina B

Este é o **Native Agent Plane**: Claude Code, Codex e AGY rodam completos na máquina A e
trabalham sobre o projeto que continua na máquina B
([ADR-022](../../adr/ADR-022-agent-plane-nativo.md),
[ADR-025](../../adr/ADR-025-workspace-server-mcp-para-os-tres-agentes.md)).

Não confunda com o **Model Plane** (`/v1`), em que o Qwen Code, o Cline e outros agentes rodam
na máquina B e só usam modelos pela máquina A — ele continua funcionando igual e tem o próprio
guia ([agentes OpenAI-compatible](./openai-compatible-agents.md)).

```text
MÁQUINA B                                         MÁQUINA A
─────────                                         ─────────
azigate-agent chat claude meu-projeto ──┐         azigate-agentd (127.0.0.1:3100)
                                        ├─ SSH ──►  ├── Claude Code ─┐
azigate-workspace (projeto) ────────────┘         ├── Codex ────────┼─ MCP ─► ponte ─► relay ─┐
     └── meu-projeto/                              └── AGY ──────────┘                          │
          ▲                                                                                     │
          └──────────────────────── ferramentas (read, edit, git, npm test…) ◄──────────────────┘
```

A máquina B **não** precisa de Claude, Codex nem AGY. A máquina A **não** tem cópia do
projeto.

## Parte 1 — Máquina A (agentes)

### 1. Pré-requisitos

```bash
node --version          # >= 22.13
codex login status      # "Logged in using ChatGPT"
claude auth status      # "loggedIn": true
agy -p=/model --output-format json   # "status":"SUCCESS"
sudo systemctl status ssh             # a máquina B vai entrar por SSH
```

Faça os logins com o mesmo usuário que vai rodar o agentd. Confira também se o modelo padrão do
Codex existe na sua conta (`model` em `~/.codex/config.toml`); se não existir, passe `--model`
no cliente (os disponíveis aparecem no `model/list` do Codex; ex.: `gpt-5.6-sol`).

### 2. Instalar

```bash
cd ~/azigate && npm ci --ignore-scripts && npm run build
openssl rand -hex 24    # → AGENT_API_KEYS (a senha que a máquina B usa)
openssl rand -hex 32    # → WORKER_TOKEN_SECRET (assina o token do Workspace Server)
```

### 3. Configurar o `.env`

```dotenv
AGENT_GATEWAY_ENABLED=true
AGENT_HOST=127.0.0.1
AGENT_PORT=3100
AGENT_API_KEYS=<primeiro segredo>
AGENT_DATA_DIR=/home/SEU_USUARIO/.local/share/azigate-agentd
CLAUDE_AGENT_ENABLED=true
CODEX_AGENT_ENABLED=true
AGY_AGENT_ENABLED=true
WORKER_ENABLED=true
WORKER_TOKEN_SECRET=<segundo segredo>
# AGY_REMOTE_AUTO_SETUP=true   (padrão) prepara o AGY para workspace remoto no startup
```

`AGENT_API_KEYS` precisa ser diferente de `GATEWAY_API_KEYS` (o agentd não sobe se forem iguais).

### 4. Subir e conferir

```bash
npm run start:agentd        # ou config/systemd/azigate-agentd.service
curl -s http://127.0.0.1:3100/ready
curl -s -H "Authorization: Bearer <AGENT_API_KEYS>" http://127.0.0.1:3100/agent/v1/providers
npm run agy:remote -- status
```

Esperado: os três providers com `"available": true` e `"remoteWorkspace": true`; o `status` do
AGY com `"ready": true`. A preparação do AGY acrescenta à configuração global dele o servidor MCP
`azigate_workspace`, o agente `azigate-workspace` e 16 regras `mcp(azigate_workspace/…)`; fora
de uma sessão do Azigate esse servidor não expõe ferramentas. Para desfazer:
`npm run agy:remote -- uninstall`.

### 5. Gerar o pacote e a configuração da máquina B

```bash
npm run pack:client
# → dist-client/azigate-client-1.0.0.tgz (≈ 45 KB, sem dependências)

npm run -s client:setup -- --worker maquina-b \
  --workspace meu-projeto=/home/USUARIO_B/projetos/meu-projeto \
  --exec npm,npx,node,git --with-agent-key
```

O `client:setup` imprime um bloco de shell para colar na máquina B. O caminho em `--workspace` é
o **da máquina B**. `--exec` lista os únicos programas que os agentes podem executar em B (cada
execução ainda pede aprovação); sem ele, a execução fica desligada. `--with-agent-key` inclui a
chave do agentd para o `azigate-agent` funcionar sem `export`.

O bloco contém segredos (token e chave): copie direto para o terminal da B e não salve em log.

## Parte 2 — Máquina B (projeto)

A máquina B não precisa do repositório do Azigate, nem de Claude, Codex ou AGY: só do Node.js
(`>=20.18.1`) e do `git`.

### 6. Instalar o pacote

Copie o `.tgz` para a B (por exemplo `scp USUARIO_A@IP_DA_MAQUINA_A:~/azigate/dist-client/azigate-client-1.0.0.tgz .`)
e instale:

```bash
npm install -g ./azigate-client-1.0.0.tgz
```

Isso cria os comandos `azigate-workspace` e `azigate-agent`.

### 7. Colar a configuração

Cole num terminal da B o bloco gerado no passo 5. Ele cria `~/.config/azigate` (pasta `0700`,
arquivos `0600`) com `workspace.json`, `workspace.token`, `agent.json` e `agent.key`.

### 8. Abrir o túnel até a máquina A (deixe aberto)

```bash
ssh -N -L 3100:127.0.0.1:3100 USUARIO_A@IP_DA_MAQUINA_A
```

O Workspace Server exige `wss://` fora do loopback; pelo túnel, `http://127.0.0.1:3100` é o
agentd da máquina A com segurança. Com Nginx e TLS, gere a configuração com
`--gateway https://seu-dominio` e dispense o túnel.

### 9. Subir o Workspace Server (deixe aberto)

```bash
azigate-workspace
```

Esperado: `{"event":"worker_registered",…}`. Confira com `azigate-agent workers` (deve listar
`maquina-b` / `meu-projeto`).

## Parte 3 — Usar

Num terceiro terminal da B:

```bash
azigate-agent chat claude meu-projeto
azigate-agent chat codex  meu-projeto --effort medium
azigate-agent chat agy    meu-projeto
```

Troca-se só o agente; o projeto continua o mesmo, na máquina B. Dentro do chat:

| Ação | Como |
|---|---|
| mandar uma tarefa | digite e Enter |
| aprovar uma escrita ou comando | `y` na pergunta `⚠ Aprovar …? [y/N]` (qualquer outra coisa nega) |
| cancelar o turno | Ctrl+C (duas vezes sai) |
| sair | `/sair` (encerra a sessão; `--keep` mantém e `--resume agt_…` retoma) |
| só leitura | `--mode plan` |
| aceitar edições sem perguntar | `--mode acceptEdits` (comandos ainda pedem aprovação) |

### Alternativa: extensão VS Code

Na máquina A, `npm run pack:vscode` gera `dist-vscode/azigate-vscode-<versão>.vsix`. Copie
o arquivo para a B e instale com **Extensions → … → Install from VSIX…** (ou
`code --install-extension azigate-vscode-<versão>.vsix`). Depois:

1. se o `client:setup` foi gerado sem `--with-agent-key`, rode **Azigate: Definir chave do
   agentd**;
2. abra o painel **Azigate** na barra de atividades e clique em **Iniciar** para subir o
   Workspace Server (substitui o passo 9) ou deixe-o rodando no terminal;
3. escolha o agente e o workspace e envie a tarefa; aprove com **Permitir** ou negue com
   **Negar**.

Com o túnel do passo 8 aberto, a URL padrão (`http://127.0.0.1:3100`) funciona sem
configuração. Detalhes em [Extensão VS Code](../modules/vscode-extension/index.md).

## Validação

- Automática, sem CLIs reais: `npm run check` (inclui a suíte comum
  `test/workspace-compat.test.ts`, que roda o mesmo cenário para os três agentes com o Workspace
  Server em outro processo).
- Real, consome cota: `AZIGATE_REAL_AGENTS=1 npm run test:agents:remote-real -- --provider agy`
  (repita com `claude` e `codex`; `CODEX_MODEL`/`CLAUDE_MODEL`/`AGY_MODEL` escolhem o modelo).
  Ela cria um repositório temporário "B" com um código aleatório, pede para ler, criar um
  arquivo e rodar `git status` e confere que tudo aconteceu em B e nada em A.

## Diagnóstico

| Sintoma | Verificação |
|---|---|
| `connection refused` na B | túnel SSH caiu |
| `O arquivo … precisa ter permissão 0600` | `chmod 600 ~/.config/azigate/*` |
| `o diretório do workspace … não existe` | caminho de `--workspace` do `client:setup` errado: gere e cole o bloco de novo |
| `worker_unavailable` | Workspace Server parado, token expirado (`4401`) ou versão sem MCP |
| `provider_unavailable` | CLI não logada com o usuário do agentd; `GET /agent/v1/providers` |
| `agent_start_failed` no AGY | `npm run agy:remote -- status`; `install` refaz a preparação |
| turno do Codex falha com `401` | a credencial do Codex em A está inválida: refaça `codex login` |
| turno do Codex falha com "model is not supported" | modelo padrão do `~/.codex/config.toml` inexistente: use `--model` |
| ferramenta `permission_denied` | modo `plan`, aprovação negada ou caminho em `.git` |
| `exec_disabled` / `command_not_allowed` | `exec` do `workspace.json` |

Logs do agentd e do Workspace Server contêm só metadados; o conteúdo existe apenas nos eventos da
sessão.

## Rollback

Pare o `azigate-agentd` e o `azigate-workspace`, rode `npm run agy:remote -- uninstall`, na B
`npm uninstall -g azigate-client && rm -rf ~/.config/azigate`, e remova
os blocos `/agent/v1/`, `/native/` e `/worker/` do Nginx, se usados. O Model Plane não depende
de nada disso.
