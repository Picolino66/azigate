# Configuração do Qwen Code

Este é um exemplo concreto de cliente. O gateway serve para qualquer agente
OpenAI-compatible; o padrão genérico e outros agentes (GitHub Copilot, Cline,
Continue) estão em [Configurar um agente OpenAI-compatible](./openai-compatible-agents.md).

## Responsabilidade

O Qwen Code permanece no seu computador, que contém o VS Code e os repositórios (no
caso do autor, um PC acessado na LAN através de uma VPN — mas pode ser qualquer
máquina). Ele envia histórico e function tools ao gateway, pede confirmação e
executa leitura, edição e shell localmente. Codex/Claude nunca recebem o cwd desse
computador.

## Descobrir a versão

```bash
qwen --version
```

Use `modelProviders` quando a versão instalada o suportar. A documentação oficial define a chave `openai`, `protocol: openai`, `models[].id`, `envKey` e `baseUrl`.

## Configuração recomendada

Em `~/.qwen/settings.json`, mescle sem remover outras configurações:

```json
{
  "modelProviders": {
    "openai": {
      "protocol": "openai",
      "models": [
        {
          "id": "deepseek-v4-pro",
          "name": "DeepSeek V4 Pro via azigate",
          "description": "Passthrough para o upstream (DeepSeek por padrão)",
          "envKey": "AZIGATE_API_KEY",
          "baseUrl": "https://ia.meudominio.com/v1",
          "generationConfig": {
            "timeout": 610000,
            "maxRetries": 0
          }
        },
        {
          "id": "deepseek-v4-flash",
          "name": "DeepSeek V4 Flash via azigate",
          "description": "Passthrough para o upstream (DeepSeek por padrão)",
          "envKey": "AZIGATE_API_KEY",
          "baseUrl": "https://ia.meudominio.com/v1",
          "generationConfig": {
            "timeout": 610000,
            "maxRetries": 0
          }
        },
        {
          "id": "codex-cli-sol",
          "name": "Codex Sol via azigate",
          "description": "GPT-5.6 Sol remoto; execução local pelo Qwen",
          "envKey": "AZIGATE_API_KEY",
          "baseUrl": "https://ia.meudominio.com/v1",
          "generationConfig": {
            "timeout": 610000,
            "maxRetries": 0
          }
        },
        {
          "id": "codex-cli-terra",
          "name": "Codex Terra via azigate",
          "description": "GPT-5.6 Terra remoto; execução local pelo Qwen",
          "envKey": "AZIGATE_API_KEY",
          "baseUrl": "https://ia.meudominio.com/v1",
          "generationConfig": {
            "timeout": 610000,
            "maxRetries": 0
          }
        },
        {
          "id": "codex-cli-luna",
          "name": "Codex Luna via azigate",
          "description": "GPT-5.6 Luna remoto; execução local pelo Qwen",
          "envKey": "AZIGATE_API_KEY",
          "baseUrl": "https://ia.meudominio.com/v1",
          "generationConfig": {
            "timeout": 610000,
            "maxRetries": 0
          }
        },
        {
          "id": "codex-cli-5.5",
          "name": "Codex GPT-5.5 via azigate",
          "description": "GPT-5.5 remoto; execução local pelo Qwen",
          "envKey": "AZIGATE_API_KEY",
          "baseUrl": "https://ia.meudominio.com/v1",
          "generationConfig": {
            "timeout": 610000,
            "maxRetries": 0
          }
        },
        {
          "id": "codex-cli-5.4",
          "name": "Codex GPT-5.4 via azigate",
          "description": "GPT-5.4 remoto; execução local pelo Qwen",
          "envKey": "AZIGATE_API_KEY",
          "baseUrl": "https://ia.meudominio.com/v1",
          "generationConfig": {
            "timeout": 610000,
            "maxRetries": 0
          }
        },
        {
          "id": "claude-cli-opus-4.8",
          "name": "Claude Opus 4.8 via azigate",
          "description": "Modelo Claude aprovado no gate real; execução local pelo Qwen",
          "envKey": "AZIGATE_API_KEY",
          "baseUrl": "https://ia.meudominio.com/v1",
          "generationConfig": {
            "timeout": 610000,
            "maxRetries": 0
          }
        }
      ]
    }
  }
}
```

Os IDs `deepseek-v4-pro`/`deepseek-v4-flash` acima são apenas exemplos de modelos do
upstream padrão (DeepSeek). Se o operador configurou outro upstream (OpenAI,
OpenRouter, etc.), use os IDs desse provedor — consulte `GET /v1/models` para ver o
que está publicado. Os aliases `codex-cli-*`/`claude-cli-*` independem do upstream.

Repita a entrada Claude trocando `id` e nome conforme a tabela. Inclua somente modelos aprovados no gate e presentes em `/v1/models`:

| ID Qwen | Modelo | Efforts expostos | Default | Gate 18/07/2026 |
|---|---|---|---|---|
| `claude-cli-fable-5` | Fable 5 | low, medium, high, xhigh, max | high | aprovado |
| `claude-cli-sonnet-5` | Sonnet 5 | low, medium, high, xhigh, max | high | aprovado |
| `claude-cli-opus-4.8` | Opus 4.8 | low, medium, high, xhigh, max | high | aprovado |
| `claude-cli-opus-4.7` | Opus 4.7 | low, medium, high, xhigh, max | xhigh | reprovado; não configurar |
| `claude-cli-opus-4.6` | Opus 4.6 | low, medium, high, max | high | aprovado |
| `claude-cli-sonnet-4.6` / `claude-cli` | Sonnet 4.6 | low, medium, high, max | high | reprovado; não configurar |
| `claude-cli-sonnet-4.5` | Sonnet 4.5 | nenhum | omitir | aprovado |
| `claude-cli-haiku-4.5` | Haiku 4.5 | nenhum | omitir | reprovado; não configurar |

## Selecionar o effort

Use o comando separado do prompt:

```text
/effort medium
```

Depois envie o pedido normalmente. O Qwen persiste `model.reasoningEffort` e envia `reasoning: { "effort": "medium" }`; o gateway aceita esse formato tanto para Codex quanto para Claude. Não adicione `extra_body.reasoning_effort` estático, pois ele tem precedência e impediria `/effort` de mudar o valor.

Para reduzir contexto excessivo, mescle também:

```json
{
  "context": {
    "autoCompactThreshold": 0.35
  },
  "model": {
    "sessionTokenLimit": 60000,
    "skipStartupContext": false
  }
}
```

Mantenha `skipStartupContext: false`: o Qwen precisa conhecer o computador onde
executa. Use `/clear` entre tarefas sem relação. O gateway recusa, sem truncar,
mensagens+tools normalizadas acima de 256 KiB.

Nos aliases Codex, `low`, `medium`, `high` e `xhigh` chegam ao CLI sem mudança, o default é `medium` e `max` aparece no log como `xhigh`. Nos aliases Claude, continuam valendo os defaults e limites da tabela; `reasoning: false` também usa o default do modelo.

Não grave o valor da chave no JSON:

```bash
export AZIGATE_API_KEY='CHAVE_DO_GATEWAY'
qwen
```

Dentro do Qwen, use `/model` para selecionar um modelo do upstream, um alias `codex-cli-*` ou um alias Claude aprovado. Effort omitido ou incompatível usa o default da tabela; Sonnet 4.5 e Haiku 4.5 ignoram qualquer effort. Todos usam a mesma `baseUrl` e chave. `codex-cli` continua selecionando GPT-5.4. O alias `claude-cli` representa Sonnet 4.6, mas permanece fora da publicação atual porque seu gate falhou. Mantenha approval interativo e não use YOLO/auto-approval.

Nos aliases CLI, mantenha `generationConfig.maxRetries: 0`. O broker não repete
uma inferência que possa ter chegado ao provider; retries do próprio binário CLI
continuam sob a implementação oficial e podem aparecer como eventos internos.

## Fallback para versão antiga

Se `modelProviders` não existir na versão instalada, use o mapeamento OpenAI-compatible por ambiente:

```bash
export OPENAI_BASE_URL='https://ia.meudominio.com/v1'
export OPENAI_API_KEY='CHAVE_DO_GATEWAY'
export OPENAI_MODEL='codex-cli-luna'
qwen
```

Esse fallback seleciona um modelo por processo. Use um ID do upstream, Codex ou Claude aprovado, por exemplo `OPENAI_MODEL=claude-cli-opus-4.8`. Não é preciso atualizar o Qwen apenas para esta integração.

## Smoke manual em repositório descartável

Depois de ativar o alias:

1. peça uma explicação sem ferramentas;
2. peça leitura e busca em dois arquivos;
3. peça uma edição e confirme a ação no Qwen;
4. peça um comando simples e confirme;
5. valide o retorno de uma tool e a continuação da conversa;
6. cancele uma execução pendente;
7. alterne entre Codex, Claude (`/effort low`, `/effort medium` e `/effort max`) e um modelo do upstream;
8. confirme no servidor que nenhum arquivo do repositório apareceu no broker.

O resultado correto é alteração somente no seu computador. Logs do gateway/broker devem conter metadados, nunca prompt, código, resposta ou argumentos.

## Referência

[Qwen Code — Model Providers](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/)
