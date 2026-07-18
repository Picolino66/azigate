# Configuração do Qwen Code no PC da VPN

## Responsabilidade

O Qwen Code permanece no computador que contém VS Code e os repositórios. Ele envia histórico e function tools ao gateway, pede confirmação e executa leitura, edição e shell localmente. Codex/Claude nunca recebem o cwd desse computador.

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
          "name": "DeepSeek V4 Pro via gateway-ai",
          "description": "Passthrough para a DeepSeek",
          "envKey": "GATEWAY_AI_API_KEY",
          "baseUrl": "https://ia.meudominio.com/v1",
          "generationConfig": {
            "timeout": 610000,
            "maxRetries": 0
          }
        },
        {
          "id": "deepseek-v4-flash",
          "name": "DeepSeek V4 Flash via gateway-ai",
          "description": "Passthrough para a DeepSeek",
          "envKey": "GATEWAY_AI_API_KEY",
          "baseUrl": "https://ia.meudominio.com/v1",
          "generationConfig": {
            "timeout": 610000,
            "maxRetries": 0
          }
        },
        {
          "id": "codex-cli-sol",
          "name": "Codex Sol via gateway-ai",
          "description": "GPT-5.6 Sol remoto; execução local pelo Qwen",
          "envKey": "GATEWAY_AI_API_KEY",
          "baseUrl": "https://ia.meudominio.com/v1",
          "generationConfig": {
            "timeout": 610000,
            "maxRetries": 0
          }
        },
        {
          "id": "codex-cli-terra",
          "name": "Codex Terra via gateway-ai",
          "description": "GPT-5.6 Terra remoto; execução local pelo Qwen",
          "envKey": "GATEWAY_AI_API_KEY",
          "baseUrl": "https://ia.meudominio.com/v1",
          "generationConfig": {
            "timeout": 610000,
            "maxRetries": 0
          }
        },
        {
          "id": "codex-cli-luna",
          "name": "Codex Luna via gateway-ai",
          "description": "GPT-5.6 Luna remoto; execução local pelo Qwen",
          "envKey": "GATEWAY_AI_API_KEY",
          "baseUrl": "https://ia.meudominio.com/v1",
          "generationConfig": {
            "timeout": 610000,
            "maxRetries": 0
          }
        },
        {
          "id": "codex-cli-5.5",
          "name": "Codex GPT-5.5 via gateway-ai",
          "description": "GPT-5.5 remoto; execução local pelo Qwen",
          "envKey": "GATEWAY_AI_API_KEY",
          "baseUrl": "https://ia.meudominio.com/v1",
          "generationConfig": {
            "timeout": 610000,
            "maxRetries": 0
          }
        },
        {
          "id": "codex-cli-5.4",
          "name": "Codex GPT-5.4 via gateway-ai",
          "description": "GPT-5.4 remoto; execução local pelo Qwen",
          "envKey": "GATEWAY_AI_API_KEY",
          "baseUrl": "https://ia.meudominio.com/v1",
          "generationConfig": {
            "timeout": 610000,
            "maxRetries": 0
          }
        },
        {
          "id": "claude-cli",
          "name": "Claude CLI via gateway-ai",
          "description": "Modelo padrão da conta; execução local pelo Qwen",
          "envKey": "GATEWAY_AI_API_KEY",
          "baseUrl": "https://ia.meudominio.com/v1",
          "generationConfig": {
            "timeout": 610000,
            "maxRetries": 0,
            "reasoningEffort": "high"
          }
        }
      ]
    }
  }
}
```

Não grave o valor da chave no JSON:

```bash
export GATEWAY_AI_API_KEY='CHAVE_DO_GATEWAY'
qwen
```

Dentro do Qwen, use `/model`: selecione `deepseek-v4-pro` ou `deepseek-v4-flash` para a DeepSeek; um alias `codex-cli-*` para Codex; ou `claude-cli` para o modelo padrão da conta Claude. Em Claude, os valores de `reasoningEffort` `low`, `medium`, `high`, `xhigh` e `max` são encaminhados de verdade; omitir usa o padrão da conta. Todos usam a mesma `baseUrl` e a mesma chave do gateway. `codex-cli` continua compatível e seleciona GPT-5.4. Mantenha o approval mode interativo e não use YOLO/auto-approval para este fluxo.

## Fallback para versão antiga

Se `modelProviders` não existir na versão instalada, use o mapeamento OpenAI-compatible por ambiente:

```bash
export OPENAI_BASE_URL='https://ia.meudominio.com/v1'
export OPENAI_API_KEY='CHAVE_DO_GATEWAY'
export OPENAI_MODEL='codex-cli-luna'
qwen
```

Esse fallback seleciona um modelo por processo. Use `OPENAI_MODEL=deepseek-v4-pro` ou `OPENAI_MODEL=deepseek-v4-flash` para DeepSeek, um dos aliases `codex-cli-*` para Codex ou `OPENAI_MODEL=claude-cli` para Claude. Não é preciso atualizar o Qwen apenas para esta integração.

## Smoke manual em repositório descartável

Depois de ativar o alias:

1. peça uma explicação sem ferramentas;
2. peça leitura e busca em dois arquivos;
3. peça uma edição e confirme a ação no Qwen;
4. peça um comando simples e confirme;
5. valide o retorno de uma tool e a continuação da conversa;
6. cancele uma execução pendente;
7. alterne entre Codex, Claude (`low`, `high` e `max`) e um modelo DeepSeek;
8. confirme no servidor que nenhum arquivo do repositório apareceu no broker.

O resultado correto é alteração somente no computador da VPN. Logs do gateway/broker devem conter metadados, nunca prompt, código, resposta ou argumentos.

## Referência

[Qwen Code — Model Providers](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/)
