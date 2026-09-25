# Runbook do Agent Plane (`azigate-agentd` e `azigate-worker`)

Operação do serviço de agentes nativos ([ADR-022](../../adr/ADR-022-agent-plane-nativo.md)).
O gateway de modelos (`azigate`) continua independente: nada aqui altera o
`/v1/chat/completions`.

## 1. Pré-requisitos no host A

- Node.js ≥ 22.13 (o agentd usa `node:sqlite`).
- As CLIs que você vai habilitar, **logadas pelo fluxo oficial** com o mesmo usuário que
  roda o agentd: `codex login`, `claude` (login da assinatura) e `agy` (login Google
  interativo). O Azigate não guarda nem renova essas credenciais.
- Versões certificadas: Codex 0.144.6, Claude Code 2.1.280, AGY 1.2.10 e 1.2.11. Com
  `AGENT_VERSION_POLICY=fail-closed` (padrão em produção), outra versão deixa o provider
  indisponível até ser recertificada.

## 2. Configurar

No `.env` (valores fictícios):

```bash
AGENT_GATEWAY_ENABLED=true
AGENT_API_KEYS=troque-por-uma-chave-longa-do-agent-plane
AGENT_TRUST_PROXY=true
AGENT_WORKSPACES_FILE=/opt/azigate/agent-workspaces.json
CLAUDE_AGENT_ENABLED=true
AGY_AGENT_ENABLED=true
CODEX_AGENT_ENABLED=true
```

`/opt/azigate/agent-workspaces.json` (somente workspaces que você aceita expor ao agente no
host A):

```json
{ "workspaces": { "azigate": { "path": "/home/operador/projetos/azigate" } } }
```

> Um workspace local roda o agente com os privilégios do usuário do agentd, sob o sistema
> de permissões da própria CLI e das aprovações do Azigate. Prefira um usuário dedicado.

## 3. Subir

```bash
npm ci --ignore-scripts && npm run build
npm run start:agentd            # ou a unidade config/systemd/azigate-agentd.service
curl -s http://127.0.0.1:3100/ready
curl -s -H "Authorization: Bearer $AGENT_KEY" http://127.0.0.1:3100/agent/v1/providers
```

Publique pelo Nginx com os blocos `/agent/v1/`, `/native/` e `/worker/v1/connect` de
[config/nginx/ia.meudominio.com.conf](../../config/nginx/ia.meudominio.com.conf) e valide
com `nginx -t`.

## 4. Usar

```bash
# criar sessão
curl -s -X POST https://ia.example.com/agent/v1/sessions \
  -H "Authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' \
  -d '{"provider":"claude","workspace":"azigate","model":"sonnet","permissionMode":"review"}'

# acompanhar eventos (em outro terminal)
curl -N -H "Authorization: Bearer $AGENT_KEY" https://ia.example.com/agent/v1/sessions/$ID/events

# enviar tarefa
curl -s -X POST https://ia.example.com/agent/v1/sessions/$ID/turns \
  -H "Authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' \
  -d '{"input":"Analise o endpoint /users e proponha paginação."}'

# aprovar ou negar o que aparecer em approval.required
curl -s -X POST https://ia.example.com/agent/v1/approvals/$APR \
  -H "Authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' -d '{"decision":"allow"}'

# cancelar o turno / encerrar a sessão
curl -s -X POST -H "Authorization: Bearer $AGENT_KEY" https://ia.example.com/agent/v1/sessions/$ID/cancel
curl -s -X DELETE -H "Authorization: Bearer $AGENT_KEY" https://ia.example.com/agent/v1/sessions/$ID
```

## 5. Worker na máquina B (projeto remoto, Claude)

1. No host A: `WORKER_ENABLED=true` e `WORKER_TOKEN_SECRET` (≥ 32 caracteres, distinto de
   todas as chaves); reinicie o agentd.
2. Gere o token no host A e copie para a máquina B:
   `npm run worker:token -- --worker devbox --workspace backend --days 90`.
3. Na máquina B, salve o token em arquivo `0600` e crie `worker.json`:

   ```json
   {
     "gateway": "https://ia.example.com",
     "workerId": "devbox",
     "tokenFile": "/home/user/.config/azigate/worker.token",
     "workspaces": { "backend": { "path": "/home/user/projetos/backend" } },
     "exec": { "enabled": true, "allowedCommands": ["npm", "node", "git"] }
   }
   ```

4. `npm ci --ignore-scripts && npm run build && npm run start:worker -- --config worker.json`
   (de preferência com um usuário dedicado). Confira em `GET /agent/v1/workers`.
5. Crie a sessão com `"worker": "devbox", "workspace": "backend"`. Só `claude` suporta
   worker nesta versão.

## 6. Diagnóstico

| Sintoma | Verificação |
|---|---|
| `503 provider_unavailable` | `GET /agent/v1/providers`: `installed`, `certified`, `enabled`; política de versão |
| `502 agent_start_failed` | CLI logada com o usuário do agentd? `claude auth status`, `codex login status`, `agy -p=/model` |
| sessão `failed` ao retomar | a sessão nativa sumiu (AGY/Claude/Codex); crie outra sessão |
| `503 worker_unavailable` | worker conectado? token expirado (`4401`)? heartbeat (`4408`)? |
| ferramenta remota `permission_denied` | modo `plan`, sessão encerrada, ou caminho em `.git` |
| `exec_disabled` / `command_not_allowed` | `exec` do `worker.json` |

Logs contêm apenas metadados (`agent_session_created`, `agent_turn_timeout`,
`worker_registered`, `worker_rejected`…). Conteúdo só existe nos eventos da sessão.

## 7. Validação real

A suíte comum usa CLIs falsas. Antes de certificar uma versão nova, rode (consome cota):

```bash
AZIGATE_REAL_AGENTS=1 npm run test:agents:real -- --provider claude --capture /tmp/fixtures-novas
```

Ela cria um repositório temporário, pede para criar/ler/editar `hello.txt`, rodar
`git diff` e `npm test`, encerra e retoma a sessão. Use `--capture` para gerar fixtures de
contrato da nova versão e atualize `CERTIFIED_VERSIONS` em `src/agents/core/versions.ts`.

## 8. Backup e rollback

- Backup: `AGENT_DATA_DIR/agentd.db` (somente metadados; sem segredos nem conteúdo).
- Rollback: `AGENT_GATEWAY_ENABLED=false` (ou pare a unidade) e remova os blocos do Nginx.
  O Model Plane não depende do agentd.
