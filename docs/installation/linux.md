# Instalação no Linux

Este guia leva você do zero até o primeiro request funcionando no Linux. Ele cobre
dois modos:

- **Modo passthrough (recomendado para começar):** apenas o gateway em container,
  encaminhando para o upstream OpenAI-compatible escolhido (DeepSeek por padrão;
  pode ser OpenAI, OpenRouter, Ollama, etc.).
- **Modo completo:** o modo passthrough somado ao login OAuth do Codex/Claude, que
  habilita os aliases `codex-cli-*` e `claude-cli-*` como adaptadores HTTP nativos.

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
    Mode -- "sim" --> Login[4. Login OAuth Codex/Claude]
    Login --> Nginx[5. Nginx / TLS]
    AgentCfg --> Done([Pronto])
    Nginx --> AgentCfg
```

## 1. Pré-requisitos

Para o **modo passthrough** você precisa de:

- Docker Engine e Docker Compose v2 (`docker compose version`);
- uma chave do upstream escolhido (DeepSeek por padrão; ou OpenAI, OpenRouter, etc.);
- opcionalmente Node.js `>=20.18.1`, caso queira rodar os testes/gates localmente.

Para o **modo completo** você também precisa:

- uma assinatura ativa do provedor que quer habilitar (ChatGPT Plus/Pro/Team para
  Codex, Claude Pro/Max/Team para Claude);
- Node.js `>=20.18.1` disponível no host para rodar o login OAuth uma única vez
  (`npm run login:codex`/`npm run login:claude`), que abre um navegador local.

Verifique o básico:

```bash
docker compose version
node --version
```

## 2. Código e variáveis de ambiente

Obtenha o projeto e crie o arquivo `.env` a partir do exemplo:

```bash
git clone <URL_DO_REPOSITORIO> azigate
cd azigate
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

Os aliases `codex-cli-*` e `claude-cli-*` falam HTTP diretamente com a Responses
API (Codex) e a Messages API (Claude), autenticados pela **assinatura** do
operador via OAuth — não por API key paga por token (ver
[ADR-018](../../adr/ADR-018-credencial-oauth-da-assinatura.md)). Não há mais
broker, systemd, Bubblewrap ou socket para instalar.

### 4.1 Fazer login uma vez por provedor

Rode localmente (fora do container, com Node.js instalado):

```bash
npm ci --ignore-scripts
npm run login:codex -- secrets/codex-oauth.json
npm run login:claude -- secrets/claude-oauth.json
```

Cada comando imprime uma URL de autorização. Abra-a no navegador, autentique-se
com a conta que tem a assinatura ativa, e o comando grava o token localmente
(diretório `0700`, arquivo `0600`) assim que o navegador for redirecionado de
volta. Nenhuma API key nova é criada. Se o login falhar ou a conta não tiver
assinatura ativa, o alias permanece indisponível (fail-closed, `cli_unavailable`).

O diretório `secrets/` já está no `.gitignore` — nunca versione esses arquivos.

Execute o login como seu usuário normal, **sem `sudo`**. O container roda como
usuário não privilegiado e precisa ler e renovar esses arquivos. Se um token tiver
sido criado por `sudo`, ele pode ficar como `root:root` e causar erro `500` ao usar
o alias. Corrija apenas proprietário e permissões, sem imprimir o token:

```bash
sudo chown "$USER":"$USER" secrets secrets/codex-oauth.json
sudo chmod 700 secrets
sudo chmod 600 secrets/codex-oauth.json
docker compose up -d --force-recreate gateway
```

Para Claude, substitua `codex-oauth.json` por `claude-oauth.json`.

### 4.2 Habilitar no `.env`

```dotenv
ENABLE_CODEX_CLI=true
ENABLE_CLAUDE_CLI=true
CODEX_TOKEN_FILE=secrets/codex-oauth.json
CLAUDE_TOKEN_FILE=secrets/claude-oauth.json
# ATENÇÃO: ALLOWED_MODELS filtra TODO o catálogo (upstream + aliases). Se preenchida,
# inclua também os IDs do upstream que quer manter, senão só os aliases habilitados aparecem.
ALLOWED_MODELS=deepseek-v4-pro,deepseek-v4-flash,claude-cli-opus-4.8
```

O container precisa montar o diretório `secrets/` para ler e renovar o token —
isso já está configurado em [docker-compose.yml](../../docker-compose.yml) via a
variável `AZIGATE_SECRETS_DIR` (default `./secrets`).

### 4.3 Recriar e verificar

```bash
docker compose up -d --force-recreate gateway
curl --fail http://127.0.0.1:3000/ready
curl --fail -H "Authorization: Bearer SUA_CHAVE_DO_GATEWAY" \
  http://127.0.0.1:3000/v1/models
```

Os aliases habilitados e com token salvo devem aparecer no catálogo.

Um request de chat, escolhendo o effort:

```bash
curl -N -H "Authorization: Bearer SUA_CHAVE_DO_GATEWAY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-cli-opus-4.8","reasoning":{"effort":"high"},"messages":[{"role":"user","content":"diga ola"}]}' \
  http://127.0.0.1:3000/v1/chat/completions
```

O formato aninhado acima é o emitido pelo Qwen Code. O campo plano
`reasoning_effort` continua aceito para compatibilidade e, se ambos forem enviados,
tem precedência.

Se o alias retornar `503 cli_unavailable`, confira se `ENABLE_CODEX_CLI`/
`ENABLE_CLAUDE_CLI` está `true`, se o login OAuth foi feito
(arquivo em `CODEX_TOKEN_FILE`/`CLAUDE_TOKEN_FILE` existe) e se o alias está em
`ALLOWED_MODELS`. A tabela de aliases, efforts e status de gate está em
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
- **Alias retorna 503 `cli_unavailable`:** o provedor está desabilitado ou o login
  OAuth não foi feito (`CODEX_TOKEN_FILE`/`CLAUDE_TOKEN_FILE` ausente). Refaça o
  passo 4.1.
- **502 `oauth_refresh_failed`:** o refresh token expirou ou foi revogado —
  refaça o login (passo 4.1).
- **Alias Codex/Claude retorna 500 logo após o login:** o token pode ter sido
  criado com `sudo` e estar inacessível ao usuário do container. Repare proprietário
  e permissões conforme o passo 4.1 e recrie o gateway.

## Rollback

Desabilite os aliases e recrie o container; o upstream continua independente:

```bash
# no .env: ENABLE_CODEX_CLI=false e ENABLE_CLAUDE_CLI=false
docker compose up -d --force-recreate gateway
```

## Referências

- [Configurar seu agente OpenAI-compatible](../operations/openai-compatible-agents.md)
- [Arquitetura](../architecture.md)
- [Contrato público](../../specs/gateway-api.md)
- [Instalação no Windows (WSL2)](./windows-wsl2.md)
