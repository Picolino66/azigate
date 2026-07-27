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
