# Protocolo interno do broker v2

O broker atende somente Unix socket. Não deve ser publicado por TCP, Nginx ou pelas rotas Fastify.

## `GET /health`

Resposta `200`:

```json
{
  "version": 2,
  "status": "ready",
  "providers": {
    "codex": { "available": true },
    "claude": { "available": false, "code": "disabled" }
  }
}
```

Os códigos de indisponibilidade são sanitizados e não contêm paths, login ou saída dos CLIs.

## `POST /execute`

Exige `Content-Type: application/json` e `X-Broker-Protocol-Version: 2`.

```json
{
  "version": 2,
  "requestId": "uuid",
  "provider": "codex",
  "model": "gpt-5.6-luna",
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

Campos extras são rejeitados. Para Codex, `model` é obrigatório e só aceita `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` ou `gpt-5.4`; para Claude ele não existe. Não existem `cwd`, `command`, `args`, `env`, `url`, `host` ou `path` operacional.

Resposta `200`:

```json
{
  "version": 2,
  "requestId": "uuid",
  "decision": {
    "content": null,
    "toolCalls": [{ "name": "read_file", "arguments": "{\"path\":\"a.txt\"}" }]
  },
  "usage": { "promptTokens": 10, "completionTokens": 4, "totalTokens": 14 }
}
```

Erros: `400 invalid_broker_request`, `413 broker_request_too_large`, `415 unsupported_media_type`, `429 cli_busy`, `502 invalid_cli_output/cli_execution_failed`, `503 cli_unavailable` e `504 cli_timeout`.
