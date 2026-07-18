# Instalação e operação do broker

## Pré-requisitos

- Linux com Bubblewrap e user namespaces habilitados;
- Node.js compatível com o projeto;
- Codex CLI e/ou Claude CLI já instalados e autenticados pelo usuário do serviço;
- gateway e broker executados com o mesmo UID para acessar o socket `0600`.

Mantenha as versões instaladas. O startup verifica capacidades e deixa o provider indisponível se algum flag ou feature exigido faltar.

```bash
codex --version
codex login status
claude --version
claude auth status
bwrap --version
id -u
id -g
```

Em hosts Ubuntu/AppArmor com `kernel.apparmor_restrict_unprivileged_userns=1`, instale o perfil nominal do Bubblewrap antes de iniciar a unidade. Isso libera user namespaces somente para `/usr/bin/bwrap`, sem desativar a restrição global:

```bash
sudo install -m 0644 config/apparmor/bwrap /etc/apparmor.d/bwrap
sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

Sem esse perfil, o health falha fechado com `bwrap_unavailable`; o kernel pode registrar negação de escrita em `uid_map`.

A unidade omite `ProtectKernelTunables`, `ProtectKernelLogs` e `ProtectHostname` porque essas diretivas impedem o namespace aninhado do Bubblewrap neste regime Ubuntu/AppArmor. O broker continua como usuário não root, com `CapabilityBoundingSet=` vazio, `NoNewPrivileges=yes`, filesystem estrito e `ProtectKernelModules=yes`; sem privilégios no namespace inicial, ele não pode alterar tunables nem hostname do host.

Não copie a saída de autenticação para tickets ou logs: algumas versões podem mostrar dados da conta.

## Build e instalação

No checkout do projeto:

```bash
npm ci --ignore-scripts
npm run check
sudo install -d -m 0755 /opt/gateway-ai
sudo rsync -a --delete dist/ /opt/gateway-ai/dist/
sudo install -m 0644 package.json /opt/gateway-ai/package.json
sudo install -m 0644 config/systemd/gateway-ai-broker@.service /etc/systemd/system/gateway-ai-broker@.service
```

Crie `/etc/gateway-ai/broker.env` com `0600`. Esse arquivo não deve conter `DEEPSEEK_API_KEY` nem `GATEWAY_API_KEYS`:

```dotenv
BROKER_SOCKET_PATH=/run/gateway-ai/broker.sock
BROKER_ENABLE_CODEX_CLI=true
BROKER_ENABLE_CLAUDE_CLI=false
BROKER_EXECUTION_TIMEOUT_MS=600000
BROKER_KILL_GRACE_MS=2000
BROKER_MAX_OUTPUT_BYTES=4194304
BWRAP_PATH=/usr/bin/bwrap
CODEX_CLI_PATH=/usr/bin/codex
CLAUDE_CLI_PATH=/home/USUARIO/.local/bin/claude
CODEX_AUTH_DIR=/home/USUARIO/.codex
CLAUDE_AUTH_DIR=/home/USUARIO/.claude
```

Proteja os diretórios e instale a unidade substituindo `USUARIO`:

```bash
chmod 0700 ~/.codex ~/.claude
sudo install -d -m 0755 /etc/gateway-ai
sudo chmod 0600 /etc/gateway-ai/broker.env
sudo systemctl daemon-reload
sudo systemctl enable --now gateway-ai-broker@USUARIO.service
```

O broker também corrige os auth dirs habilitados para `0700` no startup. O diretório `/run/gateway-ai` nasce `0700` e o socket `0600`.

A unidade usa `ProtectHome=tmpfs` e reexpõe somente `/home/USUARIO/.codex`, `/home/USUARIO/.claude` e os paths read-only da instalação Claude em `/home/USUARIO/.local`. Se o usuário tiver um home fora de `/home/USUARIO` ou o binário estiver em outro diretório, ajuste paths específicos em um override da unidade; não exponha o home inteiro.

## Verificação sem inferência

```bash
systemctl status gateway-ai-broker@USUARIO.service
curl --unix-socket /run/gateway-ai/broker.sock http://localhost/health
stat -c '%a %U:%G %n' /run/gateway-ai /run/gateway-ai/broker.sock ~/.codex ~/.claude
systemd-analyze verify config/systemd/gateway-ai-broker@.service
```

O health retorna somente disponibilidade e código sanitizado. `not_authenticated`, `required_flag_missing`, `required_feature_missing` ou `bwrap_unavailable` impedem a publicação do alias.

## Gate de viabilidade

O gate real usa 10 cenários sintéticos duas vezes e nunca aponta para um repositório:

```bash
GATE_CODEX_MODEL=gpt-5.6-sol npm run gate:codex
GATE_CODEX_MODEL=gpt-5.6-terra npm run gate:codex
GATE_CODEX_MODEL=gpt-5.6-luna npm run gate:codex
GATE_CODEX_MODEL=gpt-5.5 npm run gate:codex
GATE_CODEX_MODEL=gpt-5.4 npm run gate:codex
# somente na segunda fase
npm run gate:claude
```

Aprovação exige 20/20 decisões estruturalmente válidas, zero evento de ferramenta local e pelo menos 18/20 categorias corretas. O relatório imprime apenas contagens. Se falhar, mantenha o respectivo `ENABLE_*_CLI=false`.

Na validação de 16/07/2026, Codex `0.133.0` e Claude `2.1.150` passaram com 20/20 estruturas, zero ferramentas locais e 20/20 categorias. O primeiro smoke Codex revelou que `/etc/resolv.conf` apontava para `/run/systemd/resolve`; o isolamento foi corrigido fazendo bind read-only do arquivo resolvido, sem montar `/etc` inteiro. Se o host usar outro resolvedor, o smoke real deve falhar fechado e o alias não deve ser publicado.

## Ativação no gateway

Depois do gate aprovado, ajuste o `.env` usado pelo Compose:

```dotenv
ENABLE_CODEX_CLI=true
ENABLE_CLAUDE_CLI=false
CLI_BROKER_SOCKET_PATH=/run/gateway-ai/broker.sock
BROKER_RUNTIME_DIR=/run/gateway-ai
BROKER_UID=1000
BROKER_GID=1000
```

`BROKER_UID` e `BROKER_GID` devem corresponder ao usuário da unidade. Se `ALLOWED_MODELS` estiver preenchida, inclua todos os aliases Codex desejados: `codex-cli-sol`, `codex-cli-terra`, `codex-cli-luna`, `codex-cli-5.5`, `codex-cli-5.4` e, se necessário, o legado `codex-cli`.

```bash
docker compose config
docker compose up -d --build
curl --fail http://127.0.0.1:3000/ready
```

O container monta somente `/run/gateway-ai` como read-only. Nunca monte `~/.codex`, `~/.claude`, `/home`, o repositório ou o socket Docker.

O Compose cria o diretório do bind quando ausente para que o modo somente DeepSeek continue funcionando. Quando o broker inicia, o systemd aplica owner/mode privados ao `RuntimeDirectory`; um diretório vazio nunca torna o alias saudável sem socket e health válidos.

## Rollback

O rollback não afeta a DeepSeek:

1. defina `ENABLE_CODEX_CLI=false` e `ENABLE_CLAUDE_CLI=false`;
2. recrie o container;
3. confirme que `/v1/models` contém somente DeepSeek;
4. pare o broker se nenhum alias for usado.

```bash
docker compose up -d --force-recreate gateway
sudo systemctl disable --now gateway-ai-broker@USUARIO.service
```

## Troubleshooting

- `cli_unavailable`: consulte `/health` do socket; confirme login, versão, paths e flags.
- `cli_busy`: existe uma execução ativa; não há fila. Aguarde ou cancele no Qwen.
- `cli_timeout`: a execução excedeu 10 minutos; não aumente antes de investigar rede/login.
- `invalid_cli_output`: schema, tool name, argumentos ou evento local foi recusado; mantenha o alias desligado se for recorrente.
- `bwrap_unavailable`: valide user namespaces e o smoke de Bubblewrap no mesmo usuário/systemd.
- socket com permission denied: alinhe UID/GID do container com o usuário da unidade; não relaxe para `0666`.
- Claude indisponível: preserve o login existente e revise política/termos; não introduza API key automaticamente.
