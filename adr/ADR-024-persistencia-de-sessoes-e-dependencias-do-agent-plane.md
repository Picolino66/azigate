# ADR-024 — Persistência mínima de sessões e dependências do Agent Plane

- Status: aceito
- Fase: F2/F3 (evolução arquitetural, ciclo `native-agent-plane`)
- Data: 25/09/2026
- Relaciona-se com: ADR-001, ADR-004, ADR-022, ADR-023

## Contexto

Sessões de agente sobrevivem a turnos, a processos que morrem e a reinícios do agentd:
Codex, Claude e AGY retomam por `threadId`, `session_id` e `conversation_id`. O agentd
precisa guardar o mapeamento entre a sessão Azigate e a sessão nativa, sem guardar
conteúdo.

O agentd também precisa de WebSocket servidor (workers e endpoints nativos) e cliente
(worker). O Node.js tem cliente WebSocket global, mas não servidor.

## Alternativas consideradas

Persistência:

1. **Somente memória.** Reinício perde o vínculo com as sessões nativas. Rejeitada.
2. **Arquivo JSON com escrita atômica.** Sem dependência, mas sem consultas nem
   atualização concorrente segura. Rejeitada.
3. **SQLite embutido do Node (`node:sqlite`) (escolhida).** Sem addon nativo — importa
   porque a instalação usa `npm ci --ignore-scripts`, o que impede compilar
   `better-sqlite3`. Exige Node.js ≥ 22.13 no agentd e emite `ExperimentalWarning`.
4. **PostgreSQL.** Só se justifica com várias instâncias do agentd. Fica como evolução
   futura com novo ADR.

WebSocket:

1. **Implementar o protocolo manualmente.** Risco alto de erro de framing. Rejeitada.
2. **`ws` + `@fastify/websocket` (escolhida).** Bibliotecas maduras; o hook `onRequest`
   do Fastify autentica antes do upgrade.

## Decisão

- Tabela `sessions` com somente metadados: `id`, `provider`, `native_session_id`,
  `worker_id`, `workspace_id`, `status`, `model`, `effort`, `permission_mode`,
  `owner_credential_id`, `provider_version`, `adapter_version`, `protocol_version`,
  `created_at`, `updated_at` e `closed_at`.
- **Nunca persistir** prompt, resposta, argumentos ou resultados de ferramenta, código,
  saída de shell, tokens OAuth, API keys ou tokens de worker. Eventos (que contêm
  conteúdo) ficam apenas em buffer circular em memória por sessão, limitado por
  quantidade, e são descartados no fechamento.
- Aprovações pendentes vivem só em memória: se o agentd reiniciar, a aprovação é
  perdida e o turno falha, o que é seguro.
- No startup, sessões `starting`, `ready` ou `running` viram `suspended` (há vínculo
  nativo) ou `failed` (não há), porque nenhum processo sobrevive ao reinício.
- Banco em `AGENT_DATA_DIR` (`0700`), arquivo `0600`.
- O Model Plane continua sem banco e sem importar `node:sqlite`; a restrição
  `engines >=20.18.1` vale para ele. O agentd valida a versão do Node na inicialização.
- Dependências novas, fixadas: `ws`, `@fastify/websocket` e, em desenvolvimento,
  `@types/ws`. `@types/node` sobe para a linha 22 (a mesma da CI e da imagem) para
  tipar `node:sqlite` e o `WebSocket` global.

## Trade-offs

- `node:sqlite` ainda é experimental no Node 22; uma mudança de API exigiria ajuste no
  `SessionStore`, que isola o acesso atrás de uma interface.
- Rate limit, cache e buffer de eventos continuam locais a uma instância, como no Model
  Plane.

## Consequências

- `SessionStore` com implementação SQLite e implementação em memória para testes.
- Backup operacional passa a incluir `AGENT_DATA_DIR/agentd.db`, que não contém
  segredos nem conteúdo.
