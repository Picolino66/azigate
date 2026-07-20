# Protocolo interno do broker v5

O broker atende somente Unix socket. Não deve ser publicado por TCP, Nginx ou pelas rotas Fastify.

## `GET /health`

Resposta `200`:

```json
{
  "version": 5,
  "status": "ready",
  "providers": {
    "codex": { "available": true },
    "claude": { "available": false, "code": "disabled" }
  }
}
```

Os códigos de indisponibilidade são sanitizados e não contêm paths, login ou saída
dos CLIs. `config_file_unavailable` indica que a configuração privada exigida pelo
Claude não passou na validação local; o path nunca faz parte de `/execute`.

## `POST /execute`

Exige `Content-Type: application/json` e `X-Broker-Protocol-Version: 5`.

```json
{
  "version": 5,
  "requestId": "uuid",
  "provider": "codex",
  "model": "gpt-5.6-luna",
  "effort": "medium",
  "messages": [{ "role": "user", "content": "texto" }],
  "tools": [{
    "name": "read_file",
    "description": "Lê arquivo no computador do agente",
    "parameters": { "type": "object" }
  }],
  "toolChoice": "auto",
  "parallelToolCalls": true
}
```

Campos extras são rejeitados. Para Codex, `model` é obrigatório e só aceita `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` ou `gpt-5.4`; `effort` também é obrigatório e aceita somente `low`, `medium`, `high` ou `xhigh`. Para Claude, `model` deve pertencer ao catálogo fechado; `effort` é opcional e precisa ser compatível com o modelo. Não existem `cwd`, `command`, `args`, `env`, `url`, `host` ou `path` operacional.

Exemplo Claude:

```json
{
  "version": 5,
  "requestId": "uuid",
  "provider": "claude",
  "model": "claude-opus-4-8",
  "effort": "high",
  "messages": [{ "role": "user", "content": "texto" }],
  "tools": [],
  "toolChoice": "none",
  "parallelToolCalls": false
}
```

Resposta `200`:

```json
{
  "version": 5,
  "requestId": "uuid",
  "decision": {
    "content": null,
    "toolCalls": [{ "name": "read_file", "arguments": "{\"path\":\"a.txt\"}" }]
  },
  "usage": { "promptTokens": 10, "completionTokens": 4, "totalTokens": 14 }
}
```

Erros: `400 invalid_broker_request`, `413 broker_request_too_large`, `415 unsupported_media_type`, `429 cli_busy`, `502 invalid_cli_output/cli_execution_failed`, `503 cli_unavailable` e `504 cli_timeout`.

Modelos Claude permitidos: `claude-fable-5`, `claude-sonnet-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-sonnet-4-5` e `claude-haiku-4-5`. O gateway já envia o effort normalizado; o broker recusa combinações fora da matriz do catálogo.

Todos os modelos Codex usam default `medium`. O gateway reduz a solicitação pública `max` para `xhigh` antes do protocolo; o broker nunca aceita `max` nem argumentos de configuração arbitrários.
