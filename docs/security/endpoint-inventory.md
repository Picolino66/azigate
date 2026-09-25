# Inventário e matriz de endpoints

Data: 27/07/2026. Atualizado pela migração de broker CLI para adaptadores HTTP
nativos (ver [ADR-016](../../adr/ADR-016-substituicao-do-broker-por-adaptadores-http.md)).

## Superfície pública

| Método | Rota | Auth | Recurso | Validação e exposição | Evidência | Status |
|---|---|---|---|---|---|---|
| GET | `/health` | não | liveness local | nome/status estáticos, sem consulta a provider | teste local e smoke do container | OK |
| GET | `/ready` | não | prontidão agregada | somente status/nome; ao menos um provider utilizável | testes de degradação | OK |
| GET | `/v1/models` | Bearer gateway | catálogo combinado | allowlists; aliases apenas habilitados com token OAuth salvo; `503` se vazio | testes auth/cache/falha parcial | OK |
| POST | `/v1/chat/completions` | Bearer gateway | inferência roteada | rate limit; allowlists; upstream opaco ou tradução Codex/Claude | regressão do upstream e integração multiprovedor | OK |

Qualquer outra rota recebe `404`. Não existem login, cadastro, upload, download, pagamentos, administração, tenants, webhooks ou recursos por ID; BOLA/IDOR não se aplicam.

## Superfície privada: não existe mais

O broker, o socket Unix `0600` e o subprocesso Bubblewrap foram removidos. Os
aliases Codex/Claude não têm mais uma superfície privada intermediária — o
gateway fala HTTPS diretamente com `api.anthropic.com` e
`chatgpt.com/backend-api/codex`, autenticado por token OAuth (ver
[ADR-018](../../adr/ADR-018-credencial-oauth-da-assinatura.md)).

## Operações críticas

| Operação | Autenticação/autorizacão | Limites | Logs | Risco | Status |
|---|---|---|---|---|---|
| Consultar modelos | chave/IP/model allowlist | rate limit e cache local | metadados sem body | consumo de cota/enumeração | OK |
| Inferência do upstream | chave/IP/model | body, timeout e retries pré-resposta | sem conteúdo | custo e dados sensíveis | OK |
| Inferência Codex/Claude (HTTP nativo) | chave/IP/alias + token OAuth próprio do provedor | timeout/retry limitados a status configurados, sem fila | usage/effort sem prompt/resposta/tool arguments | detecção de cliente não-oficial (Claude), expiração/perda de token OAuth | OK automatizado; smoke real (Fase 8) pendente |
| Executar ferramenta | confirmação do agente no seu computador | política do agente | fora do gateway | alteração no repositório | smoke remoto pendente |

## Mass assignment e exposição

- O upstream aceita campos extras intencionalmente para preservar o contrato opaco, mas o destino continua fixo.
- Codex/Claude usam tradução determinística (`src/translation/`): mensagens, tools, `tool_choice`, `parallel_tool_calls`, modelo interno fixo e effort normalizado são convertidos para o corpo nativo de cada provedor; nenhum campo HTTP do cliente escolhe host, path ou credencial.
- Catálogo, health e erros não expõem token OAuth, account ID bruto do provedor ou secrets.

## Agent Plane (`azigate-agentd`)

Data: 25/09/2026 ([ADR-022](../../adr/ADR-022-agent-plane-nativo.md)). Serviço separado,
porta própria (`127.0.0.1:3100`), credenciais próprias.

| Método | Rota | Auth | Recurso | Validação e exposição | Evidência | Status |
|---|---|---|---|---|---|---|
| GET | `/health` | não | liveness | nome/status estáticos | integração agentd | OK |
| GET | `/ready` | não | prontidão | banco e ao menos um provider disponível | integração agentd | OK |
| GET | `/agent/v1/providers` | `AGENT_API_KEYS` | status das CLIs | sem path, conta ou token | integração agentd | OK |
| GET | `/agent/v1/workers` | `AGENT_API_KEYS` | workers conectados | só IDs, versões, capacidades e workspaces | integração agentd | OK |
| POST | `/agent/v1/sessions` | `AGENT_API_KEYS` | sessão | corpo estrito, workspace por ID, limites | sessões e integração | OK |
| GET | `/agent/v1/sessions/:id` | `AGENT_API_KEYS` + dono | sessão | `404` para outra credencial | sessões e integração | OK |
| POST | `/agent/v1/sessions/:id/turns` | `AGENT_API_KEYS` + dono | turno | `input` limitado; um turno por vez | sessões e integração | OK |
| GET | `/agent/v1/sessions/:id/events` | `AGENT_API_KEYS` + dono | eventos (conteúdo) | SSE; replay limitado ao buffer | integração agentd | OK |
| POST | `/agent/v1/sessions/:id/cancel` | `AGENT_API_KEYS` + dono | turno | idempotente durante o cancelamento | sessões e integração | OK |
| DELETE | `/agent/v1/sessions/:id` | `AGENT_API_KEYS` + dono | sessão | idempotente; nega aprovações pendentes | sessões e integração | OK |
| POST | `/agent/v1/approvals/:id` | `AGENT_API_KEYS` + dono | aprovação | `allow`/`deny`; `409` se já resolvida | sessões e integração | OK |
| WS | `/native/:provider/:sessionId` | `AGENT_API_KEYS` + dono | eventos nativos | somente saída; `401` antes do upgrade | integração agentd | OK |
| WS | `/worker/v1/connect` | token de worker | canal RPC | token HMAC antes do upgrade; registro validado; `maxPayload` 8 MiB | hub e integração | OK |

Superfície privada nova:

| Canal | Controle |
|---|---|
| socket Unix `AGENT_MCP_SOCKET` | `0600`, token de capacidade por sessão, modo `plan` reaplicado |
| stdin/stdout das CLIs | processo filho sem shell, ambiente mínimo, grupo de processos |

Operações críticas: executar ferramenta do agente (aprovação + modo), executar programa
no worker (desligado por padrão, allowlist, aprovação), alterar arquivo remoto (jail,
`.git` protegido).

