# Configurar um agente OpenAI-compatible

O `azigate` expõe um endpoint no formato da API OpenAI. Qualquer agente ou IDE
que ofereça a opção "OpenAI compatible API" (ou "custom OpenAI endpoint",
"OpenAI-compatible provider", "BYOK") consegue usá-lo. Este guia mostra o padrão
genérico e depois exemplos concretos para Qwen Code, GitHub Copilot, Cline e
Continue.

O agente cliente permanece no seu computador, junto do VS Code e dos repositórios.
Ele envia histórico e function tools ao gateway, recebe texto ou tool calls e
**executa as ferramentas localmente**, com as confirmações que você já usa.

```mermaid
flowchart LR
    subgraph Cliente["Seu computador"]
        Ag["Agente OpenAI-compatible"]
        Repo["Repositórios + shell"]
    end
    Gw["azigate /v1"]

    Ag -- "Base URL + API Key + model" --> Gw
    Gw -- "texto OU tool call" --> Ag
    Ag -- "executa e confirma localmente" --> Repo
```

## O padrão genérico: três campos

Praticamente todo agente OpenAI-compatible pede os mesmos três valores:

| Campo | Valor | Observação |
|---|---|---|
| **Base URL** | `https://ia.meudominio.com/v1` | inclua o sufixo `/v1`; em testes locais pode ser `http://127.0.0.1:3000/v1` |
| **API Key** | uma das `GATEWAY_API_KEYS` | enviada como `Authorization: Bearer <chave>` |
| **Model** | um ID do catálogo (tabela abaixo) | escolhe o provedor; não há fallback automático |

Boas práticas:

- Não grave a chave em arquivos versionados. Prefira variáveis de ambiente do
  agente quando disponível.
- Deixe o `timeout` do cliente maior que o do gateway (por exemplo `610000` ms) e
  `maxRetries: 0`, pois respostas de CLI podem demorar.

## Teste rápido com curl

Antes de configurar a IDE, confirme o endpoint com `curl` (o cliente OpenAI mais
simples que existe):

```bash
curl --fail -H "Authorization: Bearer SUA_CHAVE_DO_GATEWAY" \
  https://ia.meudominio.com/v1/models

curl -N -H "Authorization: Bearer SUA_CHAVE_DO_GATEWAY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-cli-opus-4.8","messages":[{"role":"user","content":"diga ola"}]}' \
  https://ia.meudominio.com/v1/chat/completions
```

## Catálogo de modelos

Você seleciona o provedor apenas pelo `model`. Os IDs abaixo batem com
[src/cli-catalog.ts](../../src/cli-catalog.ts) e o
[contrato público](../../specs/gateway-api.md).

### Upstream (passthrough)

Qualquer ID de modelo permitido pelo upstream é encaminhado de forma opaca. O
upstream é escolhido pelo operador (por padrão a DeepSeek, mas pode ser OpenAI,
OpenRouter, Together, Groq, Mistral ou um servidor local como Ollama/LM Studio/vLLM
— veja "Configurar o upstream" no [README](../../README.md#configurar-o-upstream)).
Consulte `GET /v1/models` para ver os IDs disponíveis no seu ambiente. Este caminho
funciona em **qualquer** cliente OpenAI-compatible, com ou sem suporte a tools.

### Aliases Codex e effort

| `model` | Modelo interno |
|---|---|
| `codex-cli-sol` | GPT-5.6 Sol |
| `codex-cli-terra` | GPT-5.6 Terra |
| `codex-cli-luna` | GPT-5.6 Luna |
| `codex-cli-5.5` | GPT-5.5 |
| `codex-cli-5.4` | GPT-5.4 |
| `codex-cli` | sinônimo legado de GPT-5.4 |

Os aliases Codex aceitam `reasoning_effort` ou `reasoning.effort` com `low`, `medium`, `high`, `xhigh` ou `max`. O default é `medium`; `max` é reduzido para `xhigh` antes de chegar ao CLI.

### Aliases Claude e effort

Para os aliases Claude, `reasoning_effort` ou `reasoning.effort` aceita `low`, `medium`, `high`, `xhigh` ou `max`. Um valor omitido ou incompatível é substituído pelo **default do modelo**. Sonnet 4.5 e Haiku 4.5 nunca recebem effort.

Em ambos os providers CLI, o campo plano tem precedência sobre o aninhado. `reasoning: false`, ausência ou objeto sem `effort` usa o default. Valor desconhecido ou estrutura malformada recebe `400 invalid_cli_request`; o passthrough do upstream não passa por essa normalização.

| `model` | Modelo | Efforts | Default |
|---|---|---|---|
| `claude-cli-fable-5` | Fable 5 | low, medium, high, xhigh, max | high |
| `claude-cli-sonnet-5` | Sonnet 5 | low, medium, high, xhigh, max | high |
| `claude-cli-opus-4.8` | Opus 4.8 | low, medium, high, xhigh, max | high |
| `claude-cli-opus-4.7` | Opus 4.7 | low, medium, high, xhigh, max | xhigh |
| `claude-cli-opus-4.6` | Opus 4.6 | low, medium, high, max | high |
| `claude-cli-sonnet-4.6` / `claude-cli` | Sonnet 4.6 | low, medium, high, max | high |
| `claude-cli-sonnet-4.5` | Sonnet 4.5 | nenhum | omitir |
| `claude-cli-haiku-4.5` | Haiku 4.5 | nenhum | omitir |

> Importante: nem todo alias fica publicado. Um alias só aparece em `/v1/models` se
> estiver habilitado, aprovado no gate real, com o login OAuth feito
> (`npm run login:codex`/`npm run login:claude`) e presente em `ALLOWED_MODELS`.
> O status de gate por modelo (e quais configurar) está em [qwen-code.md](qwen-code.md).
> Configure no agente apenas os modelos que aparecem no seu `GET /v1/models`.

## Compatibilidade e segurança

- **Passthrough do upstream:** funciona em qualquer cliente OpenAI-compatible,
  independentemente do provedor que o operador configurou.
- **Aliases Codex/Claude com ferramentas:** exigem que o agente envie function
  tools no formato OpenAI (`type: function`) e seja o executor. O suporte a tools
  varia por agente e por versão; se o seu cliente não envia function tools, os
  aliases ainda respondem em modo texto.
- **Aliases CLI suportam multimodal:** imagens e documentos são traduzidos para o
  formato nativo de cada provedor (ver [camada de tradução](../modules/translation/index.md)).
  Parâmetros de sampling não aplicáveis ao provedor são ignorados. Detalhes no
  [contrato público](../../specs/gateway-api.md).
- **Sem sessão no servidor:** cada requisição é traduzida e enviada de forma
  independente; use `/clear` ou equivalente no agente para controlar o tamanho do
  contexto enviado.
- **Usage:** `prompt_tokens` Claude inclui input novo, criação e leitura de cache.
  No Codex, cache já está dentro do input. Esses tokens não correspondem diretamente
  à porcentagem de cota mostrada pelo plano.
- **Mantenha aprovação interativa.** Não use YOLO/auto-approval: o agente é quem
  aplica alterações no seu computador. O gateway nunca executa ferramentas.

## Exemplos por agente

### Qwen Code

O Qwen Code tem um guia dedicado, com o exemplo completo de `modelProviders` e o
fallback por variáveis de ambiente:

- [Configuração do Qwen Code](qwen-code.md)

Em resumo, em `~/.qwen/settings.json` você declara um provider `openai` apontando
`baseUrl` para `https://.../v1`, referencia a chave por `envKey` e lista os `models`
por `id`. Em versões sem `modelProviders`, use o fallback:

```bash
export OPENAI_BASE_URL='https://ia.meudominio.com/v1'
export OPENAI_API_KEY='CHAVE_DO_GATEWAY'
export OPENAI_MODEL='claude-cli-opus-4.8'
qwen
```

### GitHub Copilot

O Copilot Chat permite, em versões recentes, adicionar modelos por um provedor
OpenAI-compatible/BYOK ("Manage Models" / "Add custom model" no editor). O suporte
e a interface **variam por versão e por editor** (VS Code, JetBrains, etc.); confira
a documentação da sua versão.

Ao adicionar o modelo customizado, preencha:

- **Provider / tipo:** OpenAI-compatible;
- **Base URL:** `https://ia.meudominio.com/v1`;
- **API Key:** a chave do gateway (`GATEWAY_API_KEYS`);
- **Model / deployment:** o ID do catálogo, por exemplo `codex-cli-luna` ou
  `claude-cli-opus-4.8`.

Se a sua versão do Copilot não expõe endpoint customizado, use o passthrough do
upstream por outro cliente OpenAI-compatible desta lista.

### Cline (extensão VS Code)

No painel de configurações do Cline, selecione o provider **"OpenAI Compatible"** e
preencha:

- **Base URL:** `https://ia.meudominio.com/v1`;
- **API Key:** a chave do gateway;
- **Model ID:** o ID do catálogo, por exemplo `claude-cli-sonnet-5`.

Mantenha as confirmações de ação ativas (não habilite auto-approve para
edições/comandos).

### Continue (extensão VS Code / JetBrains)

No arquivo de configuração do Continue (`~/.continue/config.json` ou
`config.yaml`), adicione um modelo com provider `openai` e `apiBase` apontando para
o gateway:

```json
{
  "models": [
    {
      "title": "azigate — Opus 4.8",
      "provider": "openai",
      "model": "claude-cli-opus-4.8",
      "apiBase": "https://ia.meudominio.com/v1",
      "apiKey": "CHAVE_DO_GATEWAY"
    }
  ]
}
```

O provider `openai` do Continue já envia `Authorization: Bearer`. Duplique o objeto
trocando `model`/`title` para expor mais aliases ou modelos do upstream.

## Smoke test em repositório descartável

Depois de configurar, valide o comportamento ponta a ponta (a lista detalhada está
em [qwen-code.md](qwen-code.md), e vale para qualquer agente):

1. peça uma explicação sem ferramentas;
2. peça leitura e busca em dois arquivos;
3. peça uma edição e confirme a ação no agente;
4. peça um comando simples e confirme;
5. valide o retorno de uma tool e a continuação da conversa;
6. cancele uma execução pendente;
7. alterne entre um alias Codex, um alias Claude (`low`, `high`, `max`) e um modelo
   do upstream;
8. confirme no servidor que nenhum arquivo do repositório apareceu no gateway.

O resultado correto é: alterações **somente no seu computador**; logs do gateway
contêm apenas metadados, nunca prompt, código, resposta ou argumentos.

## Referências

- [Configuração do Qwen Code](qwen-code.md)
- [Contrato público](../../specs/gateway-api.md)
- [Arquitetura](../architecture.md)
