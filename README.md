# azigate

`azigate` é um gateway **OpenAI-Compatible** self-hosted. Ele publica um endpoint
no formato da API OpenAI (`/v1/...`) que **qualquer agente ou IDE com a opção
"OpenAI compatible API"** consegue consumir — por exemplo Qwen Code, GitHub Copilot,
Cline ou Continue.

Por trás desse endpoint único, o gateway:

- faz **passthrough** para um **provedor de upstream OpenAI-compatible** escolhido
  pelo operador (o caminho padrão); e
- pode publicar **aliases opcionais** (`codex-cli-*`, `claude-cli-*`) que executam
  o Codex CLI ou o Claude CLI já autenticados no servidor, isolados por Bubblewrap.

O upstream é configurável: por padrão a **DeepSeek**, mas você pode apontar para
**OpenAI, OpenRouter, Together AI, Groq, Mistral** ou um servidor local
(**Ollama, LM Studio, vLLM**) — qualquer API que exponha `/models` e
`/chat/completions` no formato OpenAI. Veja [Configurar o upstream](#configurar-o-upstream).

O serviço **não é um proxy aberto**. A superfície HTTP é fechada e permanece
limitada a quatro rotas: `GET /health`, `GET /ready`, `GET /v1/models` e
`POST /v1/chat/completions`.

## Como funciona

O agente cliente roda no seu computador (junto do VS Code e dos repositórios). Ele
escolhe um provedor apenas pelo campo `model` e envia o histórico e as function
tools ao gateway. O gateway roteia para o provedor certo e devolve texto ou tool
calls — mas **nunca executa ferramentas locais**.

```mermaid
flowchart LR
    subgraph PC["Seu computador"]
        A["Agente OpenAI-compatible<br/>(Qwen Code, Copilot,<br/>Cline, Continue, ...)"]
    end
    subgraph SRV["Servidor (onde você quiser)"]
        N["Nginx<br/>(TLS + rotas)"]
        G["azigate<br/>(Fastify)"]
        B["broker<br/>(host, systemd)"]
        C["Codex / Claude CLI<br/>(Bubblewrap)"]
    end
    U["Upstream OpenAI-compatible<br/>(DeepSeek, OpenAI, OpenRouter,<br/>Ollama, ...)"]

    A -- "HTTPS / Bearer" --> N
    N --> G
    G -- "passthrough" --> U
    G -- "Unix socket 0600" --> B
    B -- "spawn isolado" --> C
```

### Modelo de segurança: o agente é o único executor

Para os aliases `codex-cli-*` e `claude-cli-*`, o Codex/Claude recebem **somente
texto e os esquemas das function tools**. Eles decidem *o que* fazer e devolvem uma
tool call, mas **quem executa a ferramenta é o agente no seu computador**, com as
confirmações que você já usa. O repositório, o `cwd`, o home completo e as
ferramentas locais nunca entram na sandbox do servidor.

O Claude precisa de `~/.claude` e do arquivo privado `~/.claude.json` para usar o
login existente. O broker valida ambos e copia apenas o arquivo de configuração
para um home efêmero por execução; o home real continua oculto e a cópia é apagada
com o workspace.

```mermaid
sequenceDiagram
    participant Ag as Agente (seu PC)
    participant Gw as azigate
    participant Cli as Codex/Claude (Bubblewrap)

    Ag->>Gw: POST /v1/chat/completions (texto + function tools)
    Gw->>Cli: prompt + esquemas (sem cwd, sem repo)
    Cli-->>Gw: decisão: texto OU tool call
    Gw-->>Ag: resposta OpenAI (texto OU tool call)
    Note over Ag: O agente executa a ferramenta localmente,<br/>pede confirmação e aplica a alteração
    Ag->>Gw: envia o resultado da tool e continua a conversa
```

## O que o gateway oferece

- **Passthrough do upstream:** preserva SSE byte a byte, `tool_calls`, `reasoning`,
  `usage`, campos futuros e o `[DONE]`. Funciona com qualquer provedor
  OpenAI-compatible (DeepSeek, OpenAI, OpenRouter, Ollama, etc.).
- **Aliases Codex** (`codex-cli-*`): selecionam modelos GPT fixos e recebem effort
  normalizado; `max` vira `xhigh`. São *fail-closed* e nunca caem automaticamente no upstream.
- **Aliases Claude** (`claude-cli-*`): selecionam modelos Claude fixos, com
  effort normalizado por modelo. Apenas modelos aprovados no gate real
  e presentes em `ALLOWED_MODELS` são publicados.
- **Sem vazamento de credenciais:** o container não recebe os logins dos CLIs; o
  broker não recebe as chaves do upstream/gateway.
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

- **Linux** para o stack completo (Docker/Compose, systemd, Bubblewrap e user
  namespaces). No **Windows**, use **WSL2** — veja o guia abaixo.
- Node.js `>=20.18.1` para desenvolvimento e para os gates de viabilidade; a imagem
  usa Node.js 22.
- Docker/Compose e (opcional) Nginx para publicar o gateway.
- Uma chave do upstream escolhido (DeepSeek, OpenAI, etc.).
- Login CLI existente no host e o **mesmo UID** no broker e no container para o
  socket `0600` (somente se você for habilitar os aliases Codex/Claude).

## Comece por aqui

Guias didáticos, do zero ao primeiro request:

1. [Instalação no Linux](docs/installation/linux.md)
2. [Instalação no Windows (WSL2)](docs/installation/windows-wsl2.md)
3. [Configurar seu agente OpenAI-compatible](docs/operations/openai-compatible-agents.md)
   (Qwen Code, GitHub Copilot, Cline, Continue e genérico)

Para habilitar os aliases Codex/Claude, siga também o
[runbook do broker](docs/operations/broker.md).

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
| `codex-cli-sol` / `-terra` / `-luna` | Codex CLI | GPT-5.6 Sol / Terra / Luna |
| `codex-cli-5.5` / `codex-cli-5.4` | Codex CLI | GPT-5.5 / GPT-5.4 |
| `codex-cli` | Codex CLI | sinônimo legado de GPT-5.4 |
| `claude-cli-fable-5` / `-sonnet-5` / `-opus-4.8` | Claude CLI | efforts low..max |
| `claude-cli-opus-4.7` / `-opus-4.6` / `-sonnet-4.6` | Claude CLI | ver gate por modelo |
| `claude-cli-sonnet-4.5` / `-haiku-4.5` | Claude CLI | sem `--effort` |
| `claude-cli` | Claude CLI | sinônimo legado de Sonnet 4.6 |

Aliases desabilitados retornam `503 cli_unavailable`; nunca há fallback automático.
Quando `ALLOWED_MODELS` estiver preenchida, inclua explicitamente cada alias
desejado. O catálogo completo e o roteamento estão em
[specs/gateway-api.md](specs/gateway-api.md).

Por padrão, o broker v6 mantém sessões CLI efêmeras somente em RAM: Codex usa App
Server e Claude usa `stream-json`. O primeiro turno recebe o transcript completo e
os seguintes enviam apenas o delta quando existe um único prefixo exato. O limite
preventivo é 256 KiB, sem truncamento. Detalhes de cache nos logs não equivalem
diretamente à porcentagem de cota da conta; veja o
[runbook do broker](docs/operations/broker.md#benchmark-de-sessão-e-cache).

## Desenvolvimento e gates automatizados

```bash
npm ci --ignore-scripts
npm run check
npm run test:coverage
npm audit --omit=dev --audit-level=high
```

Os testes usam upstream/broker/CLIs falsos e nunca consomem serviços reais.

## Segurança e Nginx

O exemplo em [config/nginx/ia.meudominio.com.conf](config/nginx/ia.meudominio.com.conf)
fecha rotas, termina TLS e desativa buffering/compressão/retry oculto. Ajuste
domínio e certificados e valide com `nginx -t`.

Nunca monte homes dos CLIs ou repositórios no container. Nunca exponha o socket por
TCP. Mantenha a aplicação restrita à IP allowlist e as confirmações do agente
ativas (sem YOLO/auto-approval).

## Documentação

- [Índice docs-first](docs/index.md)
- [Arquitetura](docs/architecture.md)
- [Providers](docs/modules/providers/index.md)
- [Contrato público](specs/gateway-api.md)
- [Protocolo do broker](specs/broker-api.md)
- [Threat model](docs/security/threat-model.md)

## Rollback

Desabilite os dois aliases (`ENABLE_CODEX_CLI=false`, `ENABLE_CLAUDE_CLI=false`) e
recrie o container. O upstream continua independente do broker; detalhes e
troubleshooting ficam no [runbook do broker](docs/operations/broker.md).
