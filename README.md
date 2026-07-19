# gateway-ai

Gateway OpenAI Compatible para uso pessoal em LAN/VPN. Mantém o passthrough HTTPS da DeepSeek e pode publicar aliases experimentais que usam Codex CLI ou Claude CLI autenticados no host.

```text
Qwen Code no PC da VPN -> HTTPS gateway-ai
                            ├── DeepSeek HTTPS
                            └── Unix socket -> broker -> CLI em Bubblewrap
Qwen recebe texto/tool calls e executa somente no PC da VPN
```

O serviço não é proxy aberto. A superfície continua limitada a `GET /health`, `GET /ready`, `GET /v1/models` e `POST /v1/chat/completions`.

## Propriedades principais

- DeepSeek preserva campos futuros, tool calls, reasoning, SSE, usage e `[DONE]`.
- `codex-cli-sol`, `codex-cli-terra`, `codex-cli-luna`, `codex-cli-5.5` e `codex-cli-5.4` selecionam modelos Codex fixos; `codex-cli` continua como sinônimo de GPT-5.4. Todos são reservados e nunca caem automaticamente na DeepSeek.
- Aliases `claude-cli-*` selecionam oito modelos Claude fixos; `claude-cli` é sinônimo de Sonnet 4.6. Effort é normalizado por modelo sem expor reasoning, e `ALLOWED_MODELS` publica somente modelos aprovados no gate real.
- O container não recebe os logins dos CLIs; o broker não recebe as chaves DeepSeek/gateway.
- Codex/Claude não recebem repositório, cwd ou ferramentas locais.
- Tool calls são aceitas somente se oferecidas pelo Qwen e com argumentos JSON válidos.
- Logs não contêm prompts, código, bodies, respostas, tool arguments ou secrets. O stdout diferencia cada alias conhecido com uma cor e registra somente o effort seguro efetivamente usado.

## Requisitos

- Node.js `>=20.18.1` para desenvolvimento; imagem usa Node.js 22;
- Docker/Compose e Nginx para o gateway;
- Linux, systemd, Bubblewrap e login CLI existente para aliases locais;
- mesmo UID no broker host e no container para o socket `0600`.

## Desenvolvimento e gates automatizados

```bash
npm ci --ignore-scripts
npm run check
npm run test:coverage
npm audit --omit=dev --audit-level=high
```

Os testes usam DeepSeek/broker/CLIs falsos e nunca consomem serviços reais.

## Configuração do gateway

Copie `.env.example`, defina `DEEPSEEK_API_KEY` e `GATEWAY_API_KEYS` e mantenha aliases desligados inicialmente:

```bash
cp .env.example .env
docker compose config
docker compose up -d --build
curl --fail http://127.0.0.1:3000/health
```

Variáveis novas:

| Variável | Padrão | Uso |
|---|---:|---|
| `ENABLE_CODEX_CLI` | `false` | publica os aliases Codex se o broker o marcar saudável |
| `ENABLE_CLAUDE_CLI` | `false` | habilita aliases Claude saudáveis; `ALLOWED_MODELS` decide quais foram aprovados e publicados |
| `CLI_BROKER_SOCKET_PATH` | `/run/gateway-ai/broker.sock` | socket visto pelo container |
| `CLI_REQUEST_TIMEOUT_MS` | `600000` | timeout gateway -> broker |
| `CLI_HEARTBEAT_INTERVAL_MS` | `15000` | heartbeat SSE enquanto o CLI decide |
| `BROKER_RUNTIME_DIR` | `/run/gateway-ai` | único bind do host no container |
| `BROKER_UID` / `BROKER_GID` | `1000` | identidade que acessa o socket privado |

As variáveis DeepSeek, autenticação, allowlists, limites, retries e logs permanecem documentadas em [.env.example](.env.example) e no [contrato](specs/gateway-api.md). Quando `ALLOWED_MODELS` for usada, inclua aliases explicitamente.

## Ativar Codex/Claude

Siga [instalação e operação do broker](docs/operations/broker.md). Em resumo:

1. build e instale `gateway-ai-broker@.service` no host;
2. valide login, flags, Bubblewrap, socket e permissões;
3. execute `npm run gate:codex`;
4. somente se aprovado, defina `ENABLE_CODEX_CLI=true` e recrie o gateway;
5. para cada modelo Claude, execute `GATE_CLAUDE_MODEL=<modelo> npm run gate:claude` e `GATE_CLAUDE_MODEL=<modelo> npm run gate:claude-efforts` antes de incluí-lo na allowlist.

Nenhuma API key Codex/Claude é criada. Se o login ou a política bloquear automação, o alias permanece indisponível.

## Configurar o Qwen Code

O exemplo de `modelProviders`, fallback por `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL`, confirmações e smoke remoto estão em [configuração do Qwen Code](docs/operations/qwen-code.md).

## Nginx e segurança

O exemplo em [config/nginx/ia.meudominio.com.conf](config/nginx/ia.meudominio.com.conf) fecha rotas, termina TLS e desativa buffering/compressão/retry oculto. Ajuste domínio/certificados e valide `nginx -t`.

Nunca monte homes CLI ou repositórios no container. Nunca exponha o socket por TCP. Mantenha a aplicação restrita à LAN/IP allowlist e as confirmações do Qwen ativas.

## Documentação

- [Índice docs-first](docs/index.md)
- [Arquitetura](docs/architecture.md)
- [Providers](docs/modules/providers/index.md)
- [Contrato público](specs/gateway-api.md)
- [Protocolo do broker](specs/broker-api.md)
- [Threat model](docs/security/threat-model.md)

## Rollback

Desabilite os dois aliases e recrie o container. A DeepSeek continua independente do broker; detalhes e troubleshooting ficam no [runbook](docs/operations/broker.md).
