# DeepSeek Gateway para Cline

Gateway de produção que permite ao Cline usar a API da DeepSeek por um domínio próprio, sem redirecionar o cliente e sem revelar a chave real da DeepSeek.

```text
Cline no VS Code
  -> HTTPS https://ia.meudominio.com/v1
  -> Nginx sem buffering
  -> Fastify em http://127.0.0.1:3000
  -> HTTPS https://api.deepseek.com
```

O serviço não é um proxy aberto. Só existem `GET /health`, `GET /ready`, `GET /v1/models` e `POST /v1/chat/completions`; host, protocolo, porta e path upstream são definidos exclusivamente no servidor.

## Stack e requisitos

- Node.js `>=20.18.1` (imagem Docker usa Node.js 22 Alpine);
- TypeScript, Fastify, Undici e Vitest;
- Docker com Compose para o deploy recomendado;
- Nginx 1.25.1+ para a sintaxe `http2 on` do exemplo;
- domínio apontado para uma VPS e certificado TLS válido.

Não use hospedagem compartilhada que não mantenha um processo Node/Docker ativo. A Hostinger documenta o [template Docker para VPS](https://www.hostinger.com/support/8306612-how-to-use-the-docker-vps-template-at-hostinger/) e o [Docker Manager com Compose](https://www.hostinger.com/support/12040815-how-to-deploy-your-first-container-with-hostinger-docker-manager/).

## Arquitetura e comportamento

A arquitetura completa, fronteiras de confiança e decisões ficam em [docs/architecture.md](docs/architecture.md) e [adr/](adr/). Em resumo:

- a chave Bearer recebida é comparada por digest SHA-256 com `timingSafeEqual`;
- a credencial do cliente nunca é encaminhada; o header upstream é reconstruído;
- o body de chat tem validação mínima e aceita campos desconhecidos;
- SSE é copiado incrementalmente, inclusive keep-alive, usage e `[DONE]`;
- desconexão do cliente aborta o fetch upstream;
- respostas e status da DeepSeek são preservados, com remoção defensiva de segredos em respostas bufferizadas;
- logs estruturados não incluem body, prompts, mensagens ou tool arguments;
- cache de modelos e rate limit são locais à instância.

## Variáveis de ambiente

Copie o exemplo e gere chaves longas e aleatórias:

```bash
cp .env.example .env
openssl rand -hex 32
```

| Variável | Padrão | Uso |
|---|---:|---|
| `NODE_ENV` | `development` | Ambiente; use `production` no servidor |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listener HTTP local |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | Base fixa; HTTPS obrigatório em produção |
| `DEEPSEEK_API_KEY` | obrigatório | Chave real da DeepSeek |
| `DEEPSEEK_API_KEY_FILE` | vazio | Arquivo de secret; tem precedência sobre a variável |
| `GATEWAY_API_KEYS` | obrigatório | Uma ou mais chaves separadas por vírgula |
| `GATEWAY_API_KEYS_FILE` | vazio | Arquivo de secret com as chaves; tem precedência |
| `ALLOWED_MODELS` | vazio | Allowlist CSV; vazio aceita os modelos oficiais retornados |
| `DEFAULT_MODEL` | vazio | Referência operacional; deve pertencer à allowlist quando usada |
| `ALLOWED_IPS` | vazio | Allowlist CSV de IPs exatos; vazio aceita qualquer IP autenticado |
| `REQUEST_TIMEOUT_MS` | `600000` | Timeout total do fetch upstream |
| `CONNECT_TIMEOUT_MS` | `30000` | Timeout para conexão upstream |
| `MAX_REQUEST_BODY_BYTES` | `10485760` | Limite do JSON |
| `RATE_LIMIT_MAX` | `60` | Requisições por chave/janela |
| `RATE_LIMIT_IP_MAX` | `60` | Requisições por IP/janela |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Janela local |
| `MODELS_CACHE_TTL_SECONDS` | `300` | Cache entre 60 e 600 segundos |
| `READY_CHECK_UPSTREAM` | `false` | Se `true`, `/ready` também consulta a DeepSeek |
| `UPSTREAM_MAX_RETRIES` | `0` | Retentativas, máximo 2, somente antes da resposta e em 429/502/503/504 |
| `RETRY_MAX_DELAY_MS` | `2000` | Limite de espera local de retry |
| `LOG_LEVEL` | `info` | Nível Pino |
| `TRUST_PROXY` | `true` | Confia no proxy reverso configurado |
| `MEMORY_LIMIT` / `CPU_LIMIT` | `512m` / `1.0` | Limites do serviço no Compose |

A aplicação falha no startup se os segredos faltarem ou a configuração for inválida. Em produção prefira Docker Secrets ou arquivos com permissões restritas.

## Desenvolvimento local

```bash
npm ci --ignore-scripts
cp .env.example .env
# preencha DEEPSEEK_API_KEY e GATEWAY_API_KEYS
npm run dev
```

Os testes não precisam de uma chave real e nunca chamam a DeepSeek:

```bash
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
# ou todos os gates principais
npm run check
```

## Docker e Docker Compose

Build isolado:

```bash
docker build -t deepseek-gateway:local .
docker run --rm --read-only --cap-drop=ALL \
  -p 127.0.0.1:3000:3000 \
  -e DEEPSEEK_API_KEY='SUA_CHAVE_DEEPSEEK' \
  -e GATEWAY_API_KEYS='SUA_CHAVE_GATEWAY' \
  deepseek-gateway:local
```

O Compose padrão lê `DEEPSEEK_API_KEY` e `GATEWAY_API_KEYS` do `.env`, limita capacidades e publica a porta apenas no loopback:

```bash
cp .env.example .env
# preencha as duas chaves
docker compose config
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 gateway
curl --fail http://127.0.0.1:3000/health
```

Para usar Docker Secrets baseados em arquivos, crie os arquivos fora do versionamento e aplique o override:

```bash
mkdir -p secrets
chmod 700 secrets
printf '%s' 'SUA_CHAVE_DEEPSEEK' > secrets/deepseek_api_key
printf '%s' 'SUA_CHAVE_GATEWAY' > secrets/gateway_api_keys
chmod 600 secrets/*
docker compose -f docker-compose.yml -f docker-compose.secrets.yml up -d --build
```

O diretório `secrets/` está no `.gitignore` e no `.dockerignore`.

Rotação sem indisponibilidade longa: acrescente a nova chave em `GATEWAY_API_KEYS`, recrie o container, migre o Cline e depois remova a chave antiga em uma segunda recriação. Para a DeepSeek, atualize o secret e execute `docker compose up -d --force-recreate`.

## Nginx e HTTPS

O exemplo está em [config/nginx/ia.meudominio.com.conf](config/nginx/ia.meudominio.com.conf). Ajuste o domínio e os caminhos do certificado, depois:

```bash
sudo cp config/nginx/ia.meudominio.com.conf /etc/nginx/sites-available/ia.meudominio.com
sudo ln -s /etc/nginx/sites-available/ia.meudominio.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Obtenha o certificado com o mecanismo adotado na VPS, por exemplo Certbot. Não versione chave privada. O bloco HTTP redireciona apenas para HTTPS no mesmo domínio; não redireciona para a DeepSeek. `proxy_buffering`, cache e gzip ficam desligados, `proxy_next_upstream off` impede retry oculto e `proxy_ignore_client_abort off` permite propagar cancelamento.

Em Nginx anterior a 1.25.1, substitua `listen 443 ssl;` + `http2 on;` por `listen 443 ssl http2;`. Consulte a documentação oficial de [HTTP/2](https://nginx.org/en/docs/http/ngx_http_v2_module.html), [proxy buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering) e [HTTPS](https://nginx.org/en/docs/http/configuring_https_servers.html).

Se houver Cloudflare ou outro balanceador antes do Nginx, configure `set_real_ip_from` somente para os CIDRs oficiais desse proxy. Não confie globalmente em `X-Forwarded-For` recebido da internet.

## Deploy na Hostinger VPS

1. Crie uma VPS com Docker ou instale Docker Engine/Compose.
2. Aponte o registro DNS `A` de `ia.meudominio.com` para a VPS.
3. Clone o repositório e crie `.env` com permissões `chmod 600`.
4. Execute `docker compose up -d --build`.
5. Instale o arquivo Nginx, emita o certificado e valide `nginx -t`.
6. Teste `/health`, `/ready`, `/v1/models` e um chat antes de configurar o Cline.

No Docker Manager da Hostinger, também é possível importar o Compose do repositório. Cadastre as duas chaves como variáveis protegidas e mantenha a porta 3000 acessível apenas localmente ao proxy.

## Deploy pelo Dokploy

A opção mais simples é criar uma **Application** a partir do Git/Dockerfile:

1. crie o projeto e a Application apontando para este repositório;
2. selecione Dockerfile e porta interna `3000`;
3. cadastre todas as variáveis obrigatórias na UI, marcando chaves como secrets;
4. em Domains, adicione `ia.meudominio.com`, HTTPS e a porta `3000`;
5. faça deploy e valide o streaming com `curl -N`.

Se usar o tipo Docker Compose, o Dokploy recomenda configurar o domínio na aba Domains e usar `expose` em vez de publicar uma porta no host. Remova o bind `127.0.0.1:3000:3000` nessa variante. A documentação oficial explica [Compose e variáveis](https://docs.dokploy.com/docs/core/docker-compose) e [domínios de Compose](https://docs.dokploy.com/docs/core/docker-compose/domains). Quando Traefik for o terminador TLS, não instale o Nginx em paralelo para o mesmo domínio e confirme que o proxy não bufferiza SSE.

## Testes manuais

Use um ID retornado por `/v1/models`; não suponha nomes.

Listagem:

```bash
curl https://ia.meudominio.com/v1/models \
  -H "Authorization: Bearer CHAVE_DO_GATEWAY"
```

Sem streaming:

```bash
curl https://ia.meudominio.com/v1/chat/completions \
  -H "Authorization: Bearer CHAVE_DO_GATEWAY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "MODELO_DEEPSEEK",
    "messages": [{"role":"user","content":"Responda apenas: conexão funcionando"}],
    "stream": false
  }'
```

Com streaming:

```bash
curl -N https://ia.meudominio.com/v1/chat/completions \
  -H "Authorization: Bearer CHAVE_DO_GATEWAY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "MODELO_DEEPSEEK",
    "messages": [{"role":"user","content":"Explique rapidamente o padrão repository"}],
    "stream": true,
    "stream_options": {"include_usage": true}
  }'
```

Os eventos devem aparecer progressivamente e terminar em `data: [DONE]`. Se surgirem todos de uma vez, revise buffering/compressão no CDN, Traefik ou Nginx.

Para verificar tool calls, envie `tools` com uma função simples e `tool_choice: "auto"`. Confirme na resposta `choices[].message.tool_calls[]` ou nos deltas SSE: `id`, `function.name`, `function.arguments` e `finish_reason: "tool_calls"`. Não tente parsear cada fragmento isolado de `arguments`.

## Configuração exata do Cline

1. Abrir o Cline no VS Code.
2. Abrir **Settings**.
3. Selecionar **OpenAI Compatible**.
4. Base URL: `https://ia.meudominio.com/v1`.
5. API Key: uma chave configurada em `GATEWAY_API_KEYS`.
6. Model ID: um modelo retornado por `GET /v1/models`.
7. Clicar em **Verify**.

Não use `https://ia.meudominio.com/v1/chat/completions` como Base URL. O Cline acrescenta o endpoint.

## Logs, métricas e privacidade

Cada linha JSON contém apenas request ID, método, path, status, duração, modo streaming, modelo, status upstream, tokens quando observáveis e nome sanitizado do erro. Prompts, mensagens, respostas, tool arguments, cookies e Authorization não são registrados. Os contadores `requests_total`, duração, erros upstream, rate limit, streams ativos e tokens existem internamente para um futuro adaptador Prometheus; não foi criado `/metrics` público para manter a allowlist de endpoints fechada.

## Troubleshooting

- `401`: verifique a chave do gateway, não a chave da DeepSeek no Cline.
- `403 model_not_allowed`: ajuste `ALLOWED_MODELS` ou escolha um item de `/v1/models`.
- `413`: alinhe `MAX_REQUEST_BODY_BYTES` e `client_max_body_size`.
- `429`: diferencie `rate_limit_exceeded` local do body retornado pela DeepSeek; observe `Retry-After`.
- `502`: confirme DNS/saída HTTPS da VPS para `api.deepseek.com`.
- `504`: aumente o timeout apenas após confirmar que não há falha de rede.
- Verify do Cline falha: confirme que a Base URL termina em `/v1` e que `/v1/models` responde no formato `{ "object":"list", "data":[...] }`.
- Tool call perde contexto: preserve a mensagem assistant completa, inclusive `reasoning_content`, e a mensagem `role: "tool"` com `tool_call_id`.
- SSE chega agrupado: execute `curl -N`, confira `X-Accel-Buffering: no` e desligue buffering/compressão em todos os proxies.

## Limitações conhecidas

- Rate limit e cache são por processo; múltiplas réplicas precisam de Redis ou equivalente e uma nova decisão arquitetural.
- `ALLOWED_IPS` aceita IPs exatos, não CIDR.
- `/ready` não testa a DeepSeek por padrão para não gastar requisições; habilite `READY_CHECK_UPSTREAM` conscientemente.
- Retry vem desligado por padrão para evitar duplicar chamadas potencialmente cobradas.
- Falhas depois do primeiro byte SSE não podem alterar o status HTTP já enviado.
- O gateway encaminha campos futuros, mas a DeepSeek ainda pode rejeitar parâmetros não suportados com `422`.

## Referências oficiais consultadas

- [Cline — OpenAI Compatible](https://docs.cline.bot/provider-config/openai-compatible)
- [DeepSeek — Quick start/OpenAI compatibility](https://api-docs.deepseek.com/)
- [DeepSeek — Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)
- [DeepSeek — Models](https://api-docs.deepseek.com/api/list-models/)
- [DeepSeek — Tool calls](https://api-docs.deepseek.com/guides/tool_calls/)
- [DeepSeek — Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [Nginx — ngx_http_proxy_module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
