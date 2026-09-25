# azigate

`azigate` é um gateway **OpenAI-Compatible** self-hosted. Ele publica um endpoint
no formato da API OpenAI (`/v1/...`) que **qualquer agente ou IDE com a opção
"OpenAI compatible API"** consegue consumir — por exemplo Qwen Code, GitHub Copilot,
Cline ou Continue.

Por trás desse endpoint único, o gateway:

- faz **passthrough** para um **provedor de upstream OpenAI-compatible** escolhido
  pelo operador (o caminho padrão); e
- pode publicar **aliases opcionais** (`codex-cli-*`, `claude-cli-*`) que falam
  HTTP diretamente com a Responses API da OpenAI (Codex) e a Messages API da
  Anthropic (Claude), autenticados pela assinatura do operador via OAuth.

O upstream é configurável: por padrão a **DeepSeek**, mas você pode apontar para
**OpenAI, OpenRouter, Together AI, Groq, Mistral** ou um servidor local
(**Ollama, LM Studio, vLLM**) — qualquer API que exponha `/models` e
`/chat/completions` no formato OpenAI. Veja [Configurar o upstream](#configurar-o-upstream).

O serviço **não é um proxy aberto**. A superfície HTTP é fechada e permanece
limitada a quatro rotas: `GET /health`, `GET /ready`, `GET /v1/models` e
`POST /v1/chat/completions`.

Opcionalmente, um segundo serviço — o **Agent Plane** (`azigate-agentd`) — opera Codex,
Claude Code e Google Antigravity (AGY) como **agentes completos**, pelo protocolo nativo
de cada CLI, com sessões, eventos, aprovações e execução remota em outra máquina via
`azigate-worker`. Ele roda em processo, porta e credenciais separados e não altera o
gateway de modelos. Veja [Agent Plane](#agent-plane-azigate-agentd).

## Como funciona

O agente cliente roda no seu computador (junto do VS Code e dos repositórios). Ele
escolhe um provedor apenas pelo campo `model` e envia o histórico e as function
tools ao gateway. O gateway traduz a requisição para o formato nativo do provedor
certo e devolve texto ou tool calls — mas **nunca executa ferramentas locais**.

```mermaid
flowchart LR
    subgraph PC["Seu computador"]
        A["Agente OpenAI-compatible<br/>(Qwen Code, Copilot,<br/>Cline, Continue, ...)"]
    end
    subgraph SRV["Servidor (onde você quiser)"]
        N["Nginx<br/>(TLS + rotas)"]
        G["azigate<br/>(Fastify)"]
    end
    U["Upstream OpenAI-compatible<br/>(DeepSeek, OpenAI, OpenRouter,<br/>Ollama, ...)"]
    AN["api.anthropic.com<br/>(Messages API)"]
    CX["chatgpt.com/backend-api/codex<br/>(Responses API)"]

    A -- "HTTPS / Bearer" --> N
    N --> G
    G -- "passthrough" --> U
    G -- "traduz + OAuth da assinatura" --> AN
    G -- "traduz + OAuth da assinatura" --> CX
```

### Modelo de segurança: o agente é o único executor

Para os aliases `codex-cli-*` e `claude-cli-*`, o Codex/Claude recebem **somente
texto e os esquemas das function tools**. Eles decidem *o que* fazer e devolvem uma
tool call, mas **quem executa a ferramenta é o agente no seu computador**, com as
confirmações que você já usa. O repositório, o `cwd`, o home completo e as
ferramentas locais nunca chegam ao gateway — não há mais subprocesso, sandbox nem
socket local: a garantia é estrutural, porque o gateway nunca executa nada além de
tradução e chamadas HTTP.

```mermaid
sequenceDiagram
    participant Ag as Agente (seu PC)
    participant Gw as azigate
    participant Api as Anthropic/OpenAI (HTTPS)

    Ag->>Gw: POST /v1/chat/completions (texto + function tools)
    Gw->>Api: corpo nativo traduzido (Messages/Responses) + token OAuth
    Api-->>Gw: SSE nativo incremental
    Gw-->>Ag: chunks OpenAI incrementais (texto OU tool call)
    Note over Ag: O agente executa a ferramenta localmente,<br/>pede confirmação e aplica a alteração
    Ag->>Gw: envia o resultado da tool e continua a conversa
```

## O que o gateway oferece

- **Passthrough do upstream:** preserva SSE byte a byte, `tool_calls`, `reasoning`,
  `usage`, campos futuros e o `[DONE]`. Funciona com qualquer provedor
  OpenAI-compatible (DeepSeek, OpenAI, OpenRouter, Ollama, etc.).
- **Aliases Codex** (`codex-cli-*`): selecionam modelos GPT fixos via Responses
  API, com effort normalizado (`max` vira `xhigh`), streaming incremental real e
  suporte nativo a multimodal/structured outputs. São *fail-closed* e nunca caem
  automaticamente no upstream.
- **Aliases Claude** (`claude-cli-*`): selecionam modelos Claude fixos via
  Messages API, com effort normalizado por modelo e as mesmas capacidades nativas.
- **Sem vazamento de credenciais:** cada adaptador reconstrói sua própria
  `Authorization` a partir do seu próprio segredo (token OAuth da assinatura para
  Codex/Claude, chave própria para o upstream); a credencial Bearer do cliente
  nunca segue adiante.
- **Superfície fechada e autenticada:** quatro rotas, Bearer obrigatório,
  allowlists de IP e de modelo, rate limit local.
- **Logs mínimos:** nenhum prompt, código, body, resposta, tool argument ou secret
  é registrado. O stdout apenas colore cada alias conhecido e registra o `effort`
  seguro efetivamente usado.

## Onde rodar (casos de uso)

O gateway é self-hosted e não impõe uma topologia. Rode-o onde fizer sentido:

- **Localhost / desenvolvimento:** o agente e o gateway na mesma máquina, para
  testar rápido.
- **Servidor doméstico ou lab:** uma máquina Linux dedicada na sua rede.
- **Rede local (LAN):** vários dispositivos da casa/escritório consumindo o mesmo
  gateway.
- **LAN via VPN (o caso que motivou o projeto):** você acessa o gateway na sua rede
  local a partir de fora, através de uma VPN.
- **VPS / nuvem:** atrás de Nginx com TLS e allowlists.

Em todos os casos o gateway continua **fechado e autenticado**: Bearer obrigatório,
allowlist de IP e de modelo e rate limit valem independentemente de onde ele roda.
Não é um proxy aberto.

## Requisitos

- Linux, macOS ou Windows (WSL2) — o gateway não depende mais de Bubblewrap/user
  namespaces, apenas de rede de saída para os provedores.
- Node.js `>=20.18.1` para desenvolvimento; a imagem usa Node.js 22. O Agent Plane
  (`azigate-agentd`) exige Node.js `>=22.13`.
- Docker/Compose e (opcional) Nginx para publicar o gateway.
- Uma chave do upstream escolhido (DeepSeek, OpenAI, etc.).
- Para habilitar os aliases Codex/Claude: uma conta com assinatura ativa (ChatGPT
  Plus/Pro/Team para Codex, Claude Pro/Max/Team para Claude) e o login OAuth feito
  uma vez via `npm run login:codex`/`npm run login:claude` (veja abaixo).

## Comece por aqui

Guias didáticos, do zero ao primeiro request:

1. [Instalação no Linux](docs/installation/linux.md)
2. [Instalação no Windows (WSL2)](docs/installation/windows-wsl2.md)
3. [Configurar seu agente OpenAI-compatible](docs/operations/openai-compatible-agents.md)
   (Qwen Code, GitHub Copilot, Cline, Continue e genérico)

## Habilitar os aliases Codex/Claude (OAuth da assinatura)

Os aliases `codex-cli-*`/`claude-cli-*` autenticam com a **assinatura** do
operador via OAuth, do mesmo jeito que o `codex login`/`claude` oficiais — não são
API keys pagas por token (ver [ADR-018](adr/ADR-018-credencial-oauth-da-assinatura.md)).
Para habilitar:

```bash
npm run login:codex -- secrets/codex-oauth.json
npm run login:claude -- secrets/claude-oauth.json
```

Cada comando imprime uma URL; abra-a no navegador, autentique-se e o gateway grava
o token localmente (diretório `0700`, arquivo `0600`) e o renova sozinho quando
expira. Depois, habilite no `.env`:

```bash
ENABLE_CODEX_CLI=true
ENABLE_CLAUDE_CLI=true
CODEX_TOKEN_FILE=secrets/codex-oauth.json
CLAUDE_TOKEN_FILE=secrets/claude-oauth.json
```

Risco aceito e documentado: para o Claude, o gateway não reproduz técnicas de
"cloaking"/fingerprint que imitam o cliente oficial (ver adendo do ADR-018) — a
Anthropic pode, em tese, detectar e limitar esse acesso como cliente não-oficial.

## Configurar o upstream

O upstream é definido pelo operador em duas variáveis (nomes históricos; apontam
para qualquer provedor OpenAI-compatible):

| Variável | Uso |
|---|---|
| `DEEPSEEK_BASE_URL` | raiz da API OpenAI-compatible; normalmente termina em `/v1` (ex.: `https://api.openai.com/v1`). Default: `https://api.deepseek.com` |
| `DEEPSEEK_API_KEY` | chave enviada como `Authorization: Bearer` ao upstream |

Exemplos de base URL: `https://api.deepseek.com`, `https://api.openai.com/v1`,
`https://openrouter.ai/api/v1`, `https://api.groq.com/openai/v1`. O gateway só
constrói os paths `models` e `chat/completions` sobre essa base. Em produção a base
precisa ser **HTTPS**; endpoints locais em `http://` (Ollama, LM Studio, vLLM) só
são aceitos em desenvolvimento ou atrás do seu próprio TLS.

## Modelos disponíveis

Você seleciona o provedor apenas pelo `model`. Resumo (detalhes de `reasoning_effort`/`reasoning.effort`
e defaults no [guia de agentes](docs/operations/openai-compatible-agents.md)):

| `model` | Provedor | Observação |
|---|---|---|
| qualquer ID permitido do upstream | upstream (DeepSeek por padrão) | passthrough |
| `codex-cli-sol` / `-terra` / `-luna` | Codex (Responses API) | GPT-5.6 Sol / Terra / Luna |
| `codex-cli-5.5` / `codex-cli-5.4` | Codex (Responses API) | GPT-5.5 / GPT-5.4 |
| `codex-cli` | Codex (Responses API) | sinônimo legado de GPT-5.4 |
| `claude-cli-opus-5.5` / `-opus-5` / `-fable-5.1` / `-sonnet-5` | Claude (Messages API) | efforts low..max |
| `claude-cli-haiku-4.5` | Claude (Messages API) | sem effort |
| `claude-cli` | Claude (Messages API) | sinônimo de Opus 5.5 |

Aliases desabilitados ou sem login OAuth retornam `503 cli_unavailable`; nunca há
fallback automático. Quando `ALLOWED_MODELS` estiver preenchida, inclua
explicitamente cada alias desejado. O catálogo completo e o roteamento estão em
[specs/gateway-api.md](specs/gateway-api.md).

Os aliases CLI agora suportam o mesmo passthrough rico do upstream: multimodal
(imagens/documentos), streaming incremental real token a token e structured
outputs — sem o limite fixo de transcript nem o regime de heartbeat da arquitetura
anterior (ver [ADR-016](adr/ADR-016-substituicao-do-broker-por-adaptadores-http.md)
e [ADR-017](adr/ADR-017-fim-do-regime-sintetico-de-sse.md)).

## Agent Plane (azigate-agentd)

Para usar Codex, Claude Code e AGY como agentes completos — com as ferramentas, sessões,
subagentes e permissões deles — sem convertê-los para Chat Completions
([ADR-022](adr/ADR-022-agent-plane-nativo.md)):

| | Model Plane (`azigate`) | Agent Plane (`azigate-agentd`) |
|---|---|---|
| API | `/v1/models`, `/v1/chat/completions` | `/agent/v1/sessions`, turnos, eventos (SSE), aprovações, `WS /native/*` |
| Quem executa ferramentas | o seu agente, no seu computador | o agente nativo, no workspace escolhido por ID |
| Credencial | `GATEWAY_API_KEYS` | `AGENT_API_KEYS` (nunca as mesmas) |
| Login dos fornecedores | OAuth próprio (`npm run login:*`) | o da própria CLI (`codex login`, `claude`, `agy`) |
| Estado | stateless | metadados de sessão em SQLite; eventos só em memória |
| Onde roda | container | host (usa o login das CLIs do operador) |

```bash
# host A, com as CLIs logadas pelo mesmo usuário
AGENT_GATEWAY_ENABLED=true AGENT_API_KEYS=... CLAUDE_AGENT_ENABLED=true \
AGENT_WORKSPACES_FILE=/opt/azigate/agent-workspaces.json npm run start:agentd
```

Para trabalhar num projeto que está em **outra máquina**, rode o `azigate-worker` nela:
ele conecta de saída (sem porta aberta), expõe só os workspaces declarados, protege
`.git`, mantém a execução de programas desligada por padrão e é usado pelo Claude via MCP
([ADR-023](adr/ADR-023-worker-remoto-e-isolamento-de-workspace.md)).

Contrato em [specs/agent-api.md](specs/agent-api.md), operação passo a passo em
[docs/operations/agent-plane.md](docs/operations/agent-plane.md) e módulos em
[docs/modules/agents/](docs/modules/agents/index.md).

## Desenvolvimento e gates automatizados

```bash
npm ci --ignore-scripts
npm run check
npm run test:coverage
npm audit --omit=dev --audit-level=high
```

Os testes usam upstream/Anthropic/Codex falsos (servidores HTTP locais) e CLIs de
agente falsas (`test/fixtures/agents/`), e nunca consomem serviços reais. A validação real
do Agent Plane é manual e consome cota:
`AZIGATE_REAL_AGENTS=1 npm run test:agents:real`.

## Segurança e Nginx

O exemplo em [config/nginx/ia.meudominio.com.conf](config/nginx/ia.meudominio.com.conf)
fecha rotas, termina TLS e desativa buffering/compressão/retry oculto. Ajuste
domínio e certificados e valide com `nginx -t`.

Nunca versione o diretório `secrets/` (já está no `.gitignore`). Mantenha a
aplicação restrita à IP allowlist e as confirmações do agente ativas (sem
YOLO/auto-approval).

## Documentação

- [Índice docs-first](docs/index.md)
- [Arquitetura](docs/architecture.md)
- [Providers do Model Plane](docs/modules/providers/index.md)
- [Agent Plane](docs/modules/agents/index.md)
- [Camada de tradução](docs/modules/translation/index.md)
- [Contrato público](specs/gateway-api.md)
- [Contrato do Agent Plane](specs/agent-api.md)
- [Threat model](docs/security/threat-model.md)

## Rollback

Desabilite os dois aliases (`ENABLE_CODEX_CLI=false`, `ENABLE_CLAUDE_CLI=false`) e
recrie o container. O upstream continua funcionando independentemente dos aliases
Codex/Claude.

Para o Agent Plane, pare o `azigate-agentd` (ou `AGENT_GATEWAY_ENABLED=false`) e remova
os blocos `/agent/v1/`, `/native/` e `/worker/` do Nginx; o gateway de modelos não
depende dele.
