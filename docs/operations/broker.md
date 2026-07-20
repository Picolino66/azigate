# Instalação e operação do broker

## Pré-requisitos

- Linux com Bubblewrap e user namespaces habilitados;
- Node.js compatível com o projeto;
- Codex CLI e/ou Claude CLI já instalados e autenticados pelo usuário do serviço;
- gateway e broker executados com o mesmo UID para acessar o socket `0600`.

Mantenha as versões instaladas. O startup verifica capacidades e deixa o provider
indisponível se algum flag, feature ou a configuração Codex
`model_reasoning_effort` exigida faltar. A partir do Codex CLI `0.144.6`,
`debug models` não rejeita mais um effort sentinela inválido pelo exit code. Por
isso o check carrega o catálogo embutido em JSON e confirma que todos os
modelos/efforts fixados existem, sem executar inferência. O App Server usa um home
efêmero sem `config.toml` e `--strict-config`; o modo stateless continua usando
`--ignore-user-config --strict-config`.

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
BROKER_MAX_REQUEST_BYTES=10485760
BROKER_MAX_TRANSCRIPT_BYTES=262144
BROKER_CODEX_SESSION_MODE=memory
BROKER_CLAUDE_SESSION_MODE=memory
BROKER_MAX_ACTIVE_SESSIONS=4
BROKER_SESSION_IDLE_MS=1800000
BWRAP_PATH=/usr/bin/bwrap
CODEX_CLI_PATH=/usr/bin/codex
CLAUDE_CLI_PATH=/home/USUARIO/.local/bin/claude
CODEX_AUTH_DIR=/home/USUARIO/.codex
CLAUDE_AUTH_DIR=/home/USUARIO/.claude
CLAUDE_CONFIG_PATH=/home/USUARIO/.claude.json
```

Proteja os diretórios e instale a unidade substituindo `USUARIO`:

```bash
chmod 0700 ~/.codex ~/.claude
chmod 0600 ~/.codex/auth.json ~/.claude/.credentials.json ~/.claude.json
sudo install -d -m 0755 /etc/gateway-ai
sudo chmod 0600 /etc/gateway-ai/broker.env
sudo systemctl daemon-reload
sudo systemctl enable --now gateway-ai-broker@USUARIO.service
```

O broker também corrige os auth dirs habilitados para `0700` no startup e valida os
arquivos privados usados pelo modo `memory`. O diretório `/run/gateway-ai` nasce
`0700` e o socket `0600`.

A unidade usa `ProtectHome=tmpfs` e reexpõe somente
`/home/USUARIO/.codex`, `/home/USUARIO/.claude`, o arquivo
`/home/USUARIO/.claude.json` e os paths read-only da instalação Claude em
`/home/USUARIO/.local`. O arquivo top-level fica somente leitura para o serviço e
é copiado para um home efêmero por sessão. O Bubblewrap monta somente
`auth.json` ou `.credentials.json`, não histórico/configuração do diretório inteiro.
Se o usuário tiver um home fora de
`/home/USUARIO` ou o binário estiver em outro diretório, ajuste paths específicos
em um override da unidade; não exponha o home inteiro.

## Verificação sem inferência

```bash
systemctl status gateway-ai-broker@USUARIO.service
curl --unix-socket /run/gateway-ai/broker.sock http://localhost/health
stat -c '%a %U:%G %n' /run/gateway-ai /run/gateway-ai/broker.sock ~/.codex ~/.claude ~/.claude.json
systemd-analyze verify config/systemd/gateway-ai-broker@.service
```

O health retorna somente disponibilidade e código sanitizado.
`not_authenticated`, `config_file_unavailable`, `required_flag_missing`,
`required_feature_missing` ou `bwrap_unavailable` impedem a publicação do alias.

## Gate de viabilidade

O gate real usa 10 cenários sintéticos duas vezes e nunca aponta para um repositório:

```bash
GATE_CODEX_MODEL=gpt-5.6-sol npm run gate:codex
GATE_CODEX_MODEL=gpt-5.6-terra npm run gate:codex
GATE_CODEX_MODEL=gpt-5.6-luna npm run gate:codex
GATE_CODEX_MODEL=gpt-5.5 npm run gate:codex
GATE_CODEX_MODEL=gpt-5.4 npm run gate:codex
# repita cada modelo com GATE_CODEX_EFFORT=low, high e xhigh;
# GATE_CODEX_EFFORT=max valida o mesmo valor efetivo xhigh
GATE_CLAUDE_MODEL=claude-fable-5 npm run gate:claude
GATE_CLAUDE_MODEL=claude-fable-5 npm run gate:claude-efforts
# repita os dois comandos para sonnet-5, opus-4-8, opus-4-7, opus-4-6,
# sonnet-4-6, sonnet-4-5 e haiku-4-5 usando os nomes completos
```

Aprovação exige, por modelo, 20/20 decisões estruturalmente válidas, zero evento de ferramenta local e pelo menos 18/20 categorias corretas. O segundo comando percorre todos os efforts suportados diferentes do default; Sonnet 4.5 e Haiku 4.5 já são cobertos pelo gate completo sem `--effort`. O relatório imprime somente modelo e contagens. Falha individual remove apenas os aliases correspondentes de `ALLOWED_MODELS`.

O protocolo v6 exige novo deploy coordenado do broker e gateway. A evidência
estrutural anterior continua registrada, mas App Server/stream-json precisam de
smoke por modelo/effort antes da publicação operacional. Em 18/07/2026, Fable 5,
Sonnet 5, Opus 4.8, Opus 4.6 e Sonnet 4.5 passaram no executor v4/v5; Opus 4.7,
Sonnet 4.6 e Haiku 4.5 falharam e permanecem fora da allowlist. Isso não certifica
automaticamente o novo modo multi-turn. A versão atual usa `--json-schema` como
mecanismo interno: `permissions.deny=["*"]` também o bloquearia, portanto o settings
efêmero mantém allow/deny vazios enquanto `--tools ""`, MCP estrito vazio,
`--safe-mode` e `dontAsk` desabilitam ferramentas locais. Um upgrade invalida a
evidência.

## Ativação no gateway

Depois do gate aprovado, ajuste o `.env` usado pelo Compose:

```dotenv
ENABLE_CODEX_CLI=true
ENABLE_CLAUDE_CLI=true
CLI_BROKER_SOCKET_PATH=/run/gateway-ai/broker.sock
CLI_MAX_TRANSCRIPT_BYTES=262144
BROKER_RUNTIME_DIR=/run/gateway-ai
BROKER_UID=1000
BROKER_GID=1000
```

No ambiente privado do broker, defina também `BROKER_ENABLE_CLAUDE_CLI=true`. `BROKER_UID` e `BROKER_GID` devem corresponder ao usuário da unidade. Em `ALLOWED_MODELS`, inclua somente aliases Claude aprovados; `claude-cli` e `claude-cli-sonnet-4.6` compartilham o mesmo gate.

Para a evidência atual, o trecho Claude aprovado é:

```dotenv
ALLOWED_MODELS=claude-cli-fable-5,claude-cli-sonnet-5,claude-cli-opus-4.8,claude-cli-opus-4.6,claude-cli-sonnet-4.5
```

```bash
docker compose config
docker compose up -d --build
curl --fail http://192.168.2.6:3000/ready
```

O container monta somente `/run/gateway-ai` como read-only. Nunca monte `~/.codex`, `~/.claude`, `/home`, o repositório ou o socket Docker.

O Compose cria o diretório do bind quando ausente para que o modo somente passthrough (só o upstream) continue funcionando. Quando o broker inicia, o systemd aplica owner/mode privados ao `RuntimeDirectory`; um diretório vazio nunca torna o alias saudável sem socket e health válidos.

## Rollback

O rollback não afeta o upstream:

1. defina `ENABLE_CODEX_CLI=false` e `ENABLE_CLAUDE_CLI=false`;
2. recrie o container;
3. confirme que `/v1/models` contém somente o upstream;
4. pare o broker se nenhum alias for usado.

```bash
docker compose up -d --force-recreate gateway
sudo systemctl disable --now gateway-ai-broker@USUARIO.service
```

## Troubleshooting

- `cli_unavailable`: consulte `/health` do socket; confirme login, versão, paths e flags.
- `cli_busy`: existe uma execução ativa; não há fila. Aguarde ou cancele no agente.
- `cli_timeout`: a execução excedeu 10 minutos; não aumente antes de investigar rede/login.
- `cli_context_too_large`: use compactação ou `/clear`; o gateway nunca trunca o
  transcript automaticamente.
- `invalid_cli_output`: schema, tool name, argumentos ou evento local foi recusado; mantenha o alias desligado se for recorrente.
- `bwrap_unavailable`: valide user namespaces e o smoke de Bubblewrap no mesmo usuário/systemd.
- `config_file_unavailable`: confirme que `CLAUDE_CONFIG_PATH` aponta para um
  arquivo regular, de no máximo 1 MiB, pertencente ao usuário do serviço e com
  modo `0600`; não aponte para um diretório nem relaxe as permissões.
- `cli_execution_failed` após cerca de dois segundos, com o health saudável: o
  CLI chegou ao provedor, mas pode ter recebido limite de conta (`429`) ou outro
  erro remoto. Execute um único gate diagnóstico e revise a conta; evite loops de
  retry no agente.
- socket com permission denied: alinhe UID/GID do container com o usuário da unidade; não relaxe para `0666`.
- Claude indisponível: preserve o login existente e revise política/termos; não introduza API key automaticamente.

## Benchmark de sessão e cache

Depois do deploy v6, execute uma conversa descartável de dez turnos com um arquivo
de aproximadamente 8 KiB. Confirme nos logs `sessionMode=memory`,
`sessionReused=true` a partir do segundo turno e compare `freshInputTokens`,
`cachedInputTokens`/`cacheReadInputTokens` e `cacheCreationInputTokens`. O gate de
aceite é reduzir ao menos 60% do input não cacheado após o primeiro turno, sem
retry do Qwen/gateway e sem ferramentas locais. Retries internos documentados do
próprio CLI não são controlados pelo gateway. Não use a porcentagem da UI como único
critério.

Se um provider falhar no smoke multi-turn, ajuste somente seu ambiente privado:

```dotenv
BROKER_CODEX_SESSION_MODE=stateless
BROKER_CLAUDE_SESSION_MODE=stateless
```

Reinicie o broker. Não existe fallback automático entre providers.
