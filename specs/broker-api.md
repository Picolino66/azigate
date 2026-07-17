# Protocolo interno do broker v1

O broker atende somente Unix socket. Não deve ser publicado por TCP, Nginx ou pelas rotas Fastify.

## `GET /health`

Resposta `200`:

```json
{
  "version": 1,
  "status": "ready",
  "providers": {
    "codex": { "available": true },
    "claude": { "available": false, "code": "disabled" }
  }
}
```

Os códigos de indisponibilidade são sanitizados e não contêm paths, login ou saída dos CLIs.

## `POST /execute`

Exige `Content-Type: application/json` e `X-Broker-Protocol-Version: 1`.

```json
{
  "version": 1,
  "requestId": "uuid",
  "provider": "codex",
  "messages": [{ "role": "user", "content": "texto" }],
  "tools": [{
    "name": "read_file",
    "description": "Lê arquivo no computador do Qwen",
    "parameters": { "type": "object" }
  }],
  "toolChoice": "auto",
  "parallelToolCalls": true
}
```

Campos extras são rejeitados. Não existem `cwd`, `command`, `args`, `env`, `url`, `host` ou `path` operacional.

Resposta `200`:

```json
{
  "version": 1,
  "requestId": "uuid",
  "decision": {
    "content": null,
    "toolCalls": [{ "name": "read_file", "arguments": "{\"path\":\"a.txt\"}" }]
  },
  "usage": { "promptTokens": 10, "completionTokens": 4, "totalTokens": 14 }
}
```

Erros: `400 invalid_broker_request`, `413 broker_request_too_large`, `415 unsupported_media_type`, `429 cli_busy`, `502 invalid_cli_output/cli_execution_failed`, `503 cli_unavailable` e `504 cli_timeout`.
