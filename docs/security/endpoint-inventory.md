# Inventário e matriz de endpoints

Data: 14/07/2026.

| Método | Rota | Auth exigida | Role | Recurso | IDs sensíveis | BOLA/IDOR | Mass assignment | Exposição excessiva | Teste executado | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/health` | não | N/A | liveness local | nenhum | N/A | N/A | baixo | resposta local e ausência de upstream | OK |
| GET | `/ready` | não | N/A | prontidão sanitizada | nenhum | N/A | N/A | baixo | resposta sem secrets e modo sem upstream | OK |
| GET | `/v1/models` | Bearer gateway | chave válida | catálogo DeepSeek | nenhum | N/A | N/A | baixo | sem token, token inválido, troca de chave, cache e filtro | OK |
| POST | `/v1/chat/completions` | Bearer gateway | chave válida | inferência DeepSeek | nenhum | N/A | intencionalmente aberto apenas para passthrough | médio controlado | auth, body, allowlist, campos extras, tools, SSE e erros | OK |

## Rotas públicas

- `/health`: retorna somente status e nome estático do serviço.
- `/ready`: retorna somente status e nome; conectividade upstream é opcional e não expõe detalhes.

## Rotas privadas

- `/v1/models`: exige uma das chaves configuradas no gateway.
- `/v1/chat/completions`: exige chave, rate limit e allowlists opcionais de IP/modelo.

## Operações críticas

| Operação | Endpoint | Auth | Autorização | Rate limit | Validação | Log | Risco | Status |
|---|---|---|---|---|---|---|---|---|
| Consultar modelos | `/v1/models` | sim | chave/IP | sim | rota fixa e resposta OpenAI | somente metadados | consumo de cota | OK |
| Executar inferência | `/v1/chat/completions` | sim | chave/IP/modelo | sim | JSON, tamanho, model e messages | sem conteúdo | custo, dados sensíveis, stream longo | OK |

Não existem login, cadastro, reset de senha, upload, download, pagamentos, administração, recursos por ID, tenants ou webhooks. Campos extras de chat não alteram estado local; são encaminhados somente à rota fixa da DeepSeek por exigência do contrato compatível com OpenAI.

