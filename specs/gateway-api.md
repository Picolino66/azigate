# Especificação funcional do gateway

## Rotas

| Método | Caminho | Autenticação | Upstream | Resultado |
|---|---|---|---|---|
| GET | `/health` | não | nenhum | liveness local |
| GET | `/ready` | não | opcional, configurável | readiness sem segredos |
| GET | `/v1/models` | Bearer gateway | `GET /models` | lista OpenAI, cacheada e filtrável |
| POST | `/v1/chat/completions` | Bearer gateway | `POST /chat/completions` | JSON ou SSE opaco |

Qualquer outro caminho recebe `404`; nenhum parâmetro representa uma URL upstream.

## Regras de chat

- `Content-Type` deve ser JSON.
- `model` deve ser string não vazia.
- `messages` deve ser array.
- Propriedades desconhecidas são aceitas e encaminhadas.
- `ALLOWED_MODELS` preenchida rejeita modelo ausente com `403`.
- `stream: true` seleciona passthrough SSE; qualquer outro valor usa resposta não streaming.

## Erros locais

| Status | Condição |
|---|---|
| 400 | JSON inválido ou campos mínimos inválidos |
| 401 | Bearer ausente/inválido |
| 403 | IP ou modelo fora da allowlist |
| 413 | corpo acima do limite |
| 415 | tipo de conteúdo incompatível |
| 429 | rate limit local |
| 502 | conexão/resposta upstream inválida |
| 504 | timeout upstream |
| 500 | falha inesperada sanitizada |

Status e corpos seguros da DeepSeek são preservados, inclusive `402`, `422`, `429` e `5xx`.

