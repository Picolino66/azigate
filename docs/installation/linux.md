# Instalação no Linux

Este guia leva você do zero até o primeiro request funcionando no Linux. Ele cobre
dois modos:

- **Modo passthrough (recomendado para começar):** apenas o gateway em container,
  encaminhando para o upstream OpenAI-compatible escolhido (DeepSeek por padrão;
  pode ser OpenAI, OpenRouter, Ollama, etc.). Não precisa de broker, Bubblewrap nem
  systemd.
- **Modo completo:** o modo passthrough somado ao broker no host, que habilita os
  aliases `codex-cli-*` e `claude-cli-*`.

Comece sempre pelo modo passthrough e só depois habilite os aliases.

```mermaid
flowchart TD
    Start([Início]) --> Pre[1. Pré-requisitos]
    Pre --> Env[2. Código + .env]
    Env --> Up[3. Subir o gateway]
    Up --> Check{"/health e /ready ok?"}
    Check -- "não" --> Trouble[Ver problemas comuns]
    Trouble --> Up
    Check -- "sim" --> Mode{"Quer Codex/Claude?"}
    Mode -- "não" --> AgentCfg[Configurar o agente]
    Mode -- "sim" --> Broker[4. Broker + gate<br/>ver runbook]
    Broker --> Nginx[5. Nginx / TLS]
    AgentCfg --> Done([Pronto])
    Nginx --> AgentCfg
```

## 1. Pré-requisitos

Para o **modo passthrough** você precisa de:

- Docker Engine e Docker Compose v2 (`docker compose version`);
- uma chave do upstream escolhido (DeepSeek por padrão; ou OpenAI, OpenRouter, etc.);
- opcionalmente Node.js `>=20.18.1`, caso queira rodar os testes/gates localmente.

Para o **modo completo** você também precisa, no host:

- Linux com `systemd`, Bubblewrap e user namespaces habilitados;
- Codex CLI e/ou Claude CLI já instalados e autenticados pelo usuário do serviço;
- o gateway e o broker rodando com o **mesmo UID** para acessar o socket `0600`.

Verifique o básico:

```bash
docker compose version
id -u
id -g
```

## 2. Código e variáveis de ambiente

Obtenha o projeto e crie o arquivo `.env` a partir do exemplo:

```bash
git clone <URL_DO_REPOSITORIO> gateway-ai
cd gateway-ai
cp .env.example .env
```

Edite o `.env` e preencha, no mínimo:

- `DEEPSEEK_BASE_URL` — a raiz da API OpenAI-compatible do upstream (nome histórico).
  Default `https://api.deepseek.com`; para outro provedor use, por exemplo,
  `https://api.openai.com/v1` ou `https://openrouter.ai/api/v1`.
- `DEEPSEEK_API_KEY` — a chave do upstream escolhido (enviada como Bearer ao provedor);
- `GATEWAY_API_KEYS` — uma ou mais chaves separadas por vírgula que os agentes
  usarão como Bearer token (invente valores fortes; são as senhas do gateway).

Em produção a base do upstream precisa ser HTTPS. Endpoints locais em `http://`
(Ollama, LM Studio, vLLM) só valem em desenvolvimento ou atrás do seu próprio TLS.

Mantenha os aliases desligados neste primeiro momento:

```dotenv
ENABLE_CODEX_CLI=false
ENABLE_CLAUDE_CLI=false
```

Ajuste também, conforme a sua rede:

- `GATEWAY_BIND_ADDRESS` — use `127.0.0.1` quando o Nginx estiver na mesma máquina;
  use o IP privado do servidor para acessar direto pela LAN durante testes.
- `ALLOWED_IPS` — restrinja quem pode chamar o gateway.
- `ALLOWED_MODELS` — se preenchida, publica só os modelos listados. Deixe vazia
  para publicar todo o catálogo do upstream. Ao habilitar aliases, inclua-os aqui.

As demais variáveis (timeouts, rate limit, cache, retries, logs) têm padrões
seguros e estão documentadas em
[.env.example](../../.env.example) e no [contrato público](../../specs/gateway-api.md).

## 3. Subir o gateway (modo passthrough)

Valide a configuração do Compose e suba o container:

```bash
docker compose config
docker compose up -d --build
```

Confira a saúde e o catálogo (troque a porta/host conforme o seu `.env`):

```bash
curl --fail http://127.0.0.1:3000/health
curl --fail http://127.0.0.1:3000/ready
curl --fail -H "Authorization: Bearer SUA_CHAVE_DO_GATEWAY" \
  http://127.0.0.1:3000/v1/models
```

- `/health` responde liveness local, sem autenticação.
- `/ready` responde readiness de ao menos um provedor.
- `/v1/models` exige o Bearer e lista o catálogo do upstream (mais aliases
  saudáveis, quando habilitados).

Se tudo respondeu, pule para o
[guia de configuração do agente](../operations/openai-compatible-agents.md).

## 4. Modo completo: habilitar Codex/Claude (opcional)

Os aliases `codex-cli-*` e `claude-cli-*` dependem do broker host, que isola os CLIs
com Bubblewrap. A instalação completa do broker (unidade `systemd`, Bubblewrap,
AppArmor e permissões) está no runbook — a fonte única:

- [Instalação e operação do broker](../operations/broker.md)

Abaixo, um **exemplo real** de ponta a ponta habilitando um modelo Claude. Ele mostra
os comandos concretos; os detalhes de systemd/Bubblewrap ficam no runbook acima.

### Exemplo real: publicar o alias `claude-cli-opus-4.8`

Faça tudo com o **usuário do serviço** (o mesmo UID do container). O objetivo é
publicar o alias `claude-cli-opus-4.8`, que mapeia para o modelo interno
`claude-opus-4-8`.

**4.1 Instalar e autenticar o Claude CLI (Claude Code) no host**

```bash
# Opção A - instalador nativo (vai para ~/.local/bin/claude, que casa com o .env.example)
curl -fsSL https://claude.ai/install.sh | bash
# Opção B - via npm
npm install -g @anthropic-ai/claude-code

# Confirme o caminho real e a versão
which claude
claude --version

# Faça login uma vez (interativo) e verifique
claude
claude auth status

# Proteja o diretório de autenticação
chmod 0700 ~/.claude
```

Nenhuma API key nova é criada: o broker usa o login existente. Se o login ou a
política bloquear a automação, o alias permanece indisponível (fail-closed).

**4.2 Apontar o broker para o binário e o auth dir do Claude**

Na configuração do broker (`/etc/gateway-ai/broker.env`, `0600`), troque `USUARIO`
pelo seu usuário e use o caminho retornado por `which claude`:

```dotenv
BROKER_ENABLE_CLAUDE_CLI=true
CLAUDE_CLI_PATH=/home/USUARIO/.local/bin/claude
CLAUDE_AUTH_DIR=/home/USUARIO/.claude
```

A instalação da unidade `gateway-ai-broker@USUARIO.service` e o `reload` estão no
[runbook do broker](../operations/broker.md).

**4.3 Rodar o gate real para o modelo**

O gate valida a viabilidade do modelo com cenários sintéticos (nunca aponta para um
repositório). Para `claude-opus-4-8`:

```bash
GATE_CLAUDE_MODEL=claude-opus-4-8 npm run gate:claude
GATE_CLAUDE_MODEL=claude-opus-4-8 npm run gate:claude-efforts
```

Aprovação exige 20/20 decisões estruturalmente válidas, zero evento de ferramenta
local e ao menos 18/20 categorias corretas. Só continue se o modelo for aprovado.

**4.4 Publicar o alias no gateway**

No `.env` usado pelo Compose:

```dotenv
ENABLE_CLAUDE_CLI=true
# ATENÇÃO: ALLOWED_MODELS filtra TODO o catálogo (upstream + aliases). Se preenchida,
# inclua também os IDs do upstream que quer manter, senão só o alias Claude aparece.
# Troque deepseek-v4-* pelos IDs reais do seu upstream (veja GET /v1/models).
ALLOWED_MODELS=deepseek-v4-pro,deepseek-v4-flash,claude-cli-opus-4.8
```

No ambiente do broker, `BROKER_ENABLE_CLAUDE_CLI=true` já foi definido no passo 4.2.
Recrie o gateway:

```bash
docker compose up -d --force-recreate gateway
curl --fail http://127.0.0.1:3000/ready
```

**4.5 Verificar e testar**

O alias deve aparecer no catálogo:

```bash
curl --fail -H "Authorization: Bearer SUA_CHAVE_DO_GATEWAY" \
  http://127.0.0.1:3000/v1/models
```

Um request de chat, escolhendo o effort:

```bash
curl -N -H "Authorization: Bearer SUA_CHAVE_DO_GATEWAY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-cli-opus-4.8","reasoning_effort":"high","messages":[{"role":"user","content":"diga ola"}]}' \
  http://127.0.0.1:3000/v1/chat/completions
```

Se o alias retornar `503 cli_unavailable`, confira o broker (health do socket, login,
`BROKER_ENABLE_CLAUDE_CLI`, caminho do binário) no [runbook](../operations/broker.md).

Para publicar outros modelos Claude, repita 4.3 e 4.4 com o nome interno
correspondente (por exemplo `claude-fable-5`, `claude-sonnet-5`, `claude-opus-4-6`,
`claude-sonnet-4-5`) e acrescente o alias público à `ALLOWED_MODELS`. Para o Codex, o
fluxo é análogo com `npm run gate:codex` e `ENABLE_CODEX_CLI=true`. A tabela de
aliases, efforts e status de gate está em
[Configurar um agente OpenAI-compatible](../operations/openai-compatible-agents.md).

## 5. Publicar com Nginx e TLS

Para expor o gateway com HTTPS e a superfície fechada, use o exemplo de
configuração e ajuste domínio/certificados:

- [config/nginx/ia.meudominio.com.conf](../../config/nginx/ia.meudominio.com.conf)

Ele termina TLS, libera apenas as quatro rotas conhecidas e desativa
buffering/compressão/retry oculto. Valide antes de recarregar:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Mantenha `GATEWAY_BIND_ADDRESS=127.0.0.1` para que o container só receba tráfego
via Nginx.

## Verificação e problemas comuns

- **`/health` não responde:** confira `docker compose ps` e
  `docker compose logs gateway`. Verifique a porta em `PORT`/`GATEWAY_BIND_ADDRESS`.
- **`/v1/models` retorna 401:** falta o header `Authorization: Bearer <chave>` com
  uma das chaves definidas em `GATEWAY_API_KEYS`.
- **403 `ip_not_allowed`:** o IP de origem não está em `ALLOWED_IPS`.
- **403 `model_not_allowed`:** o `model` não está em `ALLOWED_MODELS`.
- **Alias retorna 503 `cli_unavailable`:** o broker está desligado, não passou no
  gate, ou o alias não está em `ALLOWED_MODELS`. Consulte o
  [runbook do broker](../operations/broker.md).
- **Socket com permissão negada:** alinhe `BROKER_UID`/`BROKER_GID` do container ao
  usuário da unidade `systemd`; não relaxe as permissões do socket.

## Rollback

Desabilite os aliases e recrie o container; o upstream continua independente:

```bash
# no .env: ENABLE_CODEX_CLI=false e ENABLE_CLAUDE_CLI=false
docker compose up -d --force-recreate gateway
```

## Referências

- [Instalação e operação do broker](../operations/broker.md)
- [Configurar seu agente OpenAI-compatible](../operations/openai-compatible-agents.md)
- [Arquitetura](../architecture.md)
- [Contrato público](../../specs/gateway-api.md)
- [Instalação no Windows (WSL2)](./windows-wsl2.md)
