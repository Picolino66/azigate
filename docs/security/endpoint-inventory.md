# Inventário e matriz de endpoints

Data: 20/07/2026.

## Superfície pública

| Método | Rota | Auth | Recurso | Validação e exposição | Evidência | Status |
|---|---|---|---|---|---|---|
| GET | `/health` | não | liveness local | nome/status estáticos, sem consulta a provider | teste local e smoke do container | OK |
| GET | `/ready` | não | prontidão agregada | somente status/nome; ao menos um provider utilizável | testes de degradação | OK |
| GET | `/v1/models` | Bearer gateway | catálogo combinado | allowlists; aliases apenas habilitados/saudáveis; `503` se vazio | testes auth/cache/falha parcial | OK |
| POST | `/v1/chat/completions` | Bearer gateway | inferência roteada | rate limit; allowlists; upstream opaco ou subconjunto CLI estrito | regressão do upstream e integração broker | OK |

Qualquer outra rota recebe `404`. Não existem login, cadastro, upload, download, pagamentos, administração, tenants, webhooks ou recursos por ID; BOLA/IDOR não se aplicam.

## Superfície privada do broker

Não é TCP nem pública. Existe somente no Unix socket `0600`, sob diretório `0700`.

| Método | Rota | Controle | Entrada | Saída | Status |
|---|---|---|---|---|---|
| GET | `/health` | filesystem/UID + protocolo local | nenhuma | versão e capacidade sanitizada | OK |
| POST | `/execute` | filesystem/UID + header v5 + JSON | request ID, provider, modelo CLI permitido, effort efetivo, mensagens e function tools | decisão estruturada ou erro sanitizado | OK |

`/execute` rejeita campos extras, inclusive `cwd`, comando, argv, ambiente, URL e path. O gateway reconstrói a entrada; nenhum campo HTTP do agente cliente escolhe binário ou filesystem.

## Operações críticas

| Operação | Autenticação/autorizacão | Limites | Logs | Risco | Status |
|---|---|---|---|---|---|
| Consultar modelos | chave/IP/model allowlist | rate limit e cache local | metadados sem body | consumo de cota/enumeração | OK |
| Inferência do upstream | chave/IP/model | body, timeout e retries pré-resposta | sem conteúdo | custo e dados sensíveis | OK |
| Decisão Codex/Claude | chave/IP/alias + socket UID | 1 execução, 10 min, 4 MiB, sem retry | sem prompt/stdout/stderr | login CLI e prompt injection; Claude usa cópia efêmera privada de `.claude.json` | OK local |
| Executar ferramenta | confirmação do agente no seu computador | política do agente | fora do gateway | alteração no repositório | smoke remoto pendente |

## Mass assignment e exposição

- O upstream aceita campos extras intencionalmente para preservar o contrato opaco, mas o destino continua fixo.
- CLI usa reconstrução allowlist: somente mensagens textuais, function tools, `tool_choice`, `parallel_tool_calls`, modelo interno fixo e effort normalizado entram no broker.
- Catálogo, health e erros não expõem paths de binário/auth, argv, stderr, account ID ou secrets.
