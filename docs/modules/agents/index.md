# Módulo Agent Plane

O Agent Plane é o serviço `azigate-agentd`, separado do gateway de modelos, que opera
Codex, Claude Code e Google Antigravity CLI (AGY) como **agentes completos**, pelo
protocolo nativo de cada um ([ADR-022](../../../adr/ADR-022-agent-plane-nativo.md)).
Ele não traduz nada para Chat Completions: expõe sessões, turnos, eventos e aprovações e
anexa sempre a mensagem original da CLI.

```text
Cliente (curl, IDE, script) ── HTTPS ──► Nginx ──► azigate-agentd (host A)
                                                     ├── codex app-server   (stdio JSON-RPC)
                                                     ├── claude -p          (stdio stream-json)
                                                     ├── agy                (stdio stream-json)
                                                     └── WS ◄── azigate-worker (máquina B, conexão de saída)
```

| Plano | Processo | Estado | Executor de ferramentas |
|---|---|---|---|
| Model Plane | `azigate` (`dist/server.js`) | stateless | o agente cliente, no computador dele (ADR-006) |
| Agent Plane | `azigate-agentd` (`dist/agentd/server.js`) | sessões em SQLite | o agente nativo, no workspace escolhido por ID |

## Features

- [Serviço `azigate-agentd`](./agentd.md) — configuração, credenciais, rotas, limites e startup.
- [Sessões e turnos](./sessions.md) — ciclo de vida, suspensão, retomada e persistência.
- [Eventos e endpoint nativo](./events.md) — eventos universais, SSE e `WS /native`.
- [Aprovações](./approvals.md) — pedidos de permissão nativos como entidade do Azigate.
- [Provider Codex](./codex-agent.md) — `codex app-server`.
- [Provider Claude Code](./claude-agent.md) — `claude -p` em `stream-json`.
- [Provider AGY](./agy-agent.md) — `agy` headless em `stream-json`.
- [Worker remoto](./worker.md) — `azigate-worker`, jail de workspace e protocolo.
- [Workspace remoto via MCP](./remote-workspace-mcp.md) — Claude na máquina A, projeto na máquina B.

## Código

| Pasta | Responsabilidade |
|---|---|
| `src/agents/core/` | contrato `AgentProvider`, eventos universais, registry, processo, NDJSON, JSON-RPC, versões |
| `src/agents/{codex,claude,agy}/` | adaptadores nativos e mapeamento de eventos |
| `src/agent-control/` | `SessionService`, aprovações, buffer de eventos, `SessionStore`, workspaces, `WorkerHub`, ferramentas remotas |
| `src/agentd/` | serviço Fastify, config, rotas, socket MCP e gerador de token de worker |
| `src/worker-protocol/` | mensagens, esquemas, transporte e token do worker |
| `src/worker/` | executável `azigate-worker` |
| `src/mcp-bridge/` | executável `azigate-mcp-bridge` |

## Contratos e decisões

- [Contrato do Agent Plane](../../../specs/agent-api.md) e [OpenAPI](../../../specs/agent-openapi.yaml)
- [Protocolo do worker e da ponte MCP](../../../specs/worker-protocol.md)
- [ADR-022](../../../adr/ADR-022-agent-plane-nativo.md),
  [ADR-023](../../../adr/ADR-023-worker-remoto-e-isolamento-de-workspace.md),
  [ADR-024](../../../adr/ADR-024-persistencia-de-sessoes-e-dependencias-do-agent-plane.md)
- [Runbook de operação](../../operations/agent-plane.md)
- [Plano rastreável](../../../tasks/native-agent-plane-plan.md)

## Matriz certificada

| Provider | Versão certificada | Protocolo | Worker remoto |
|---|---|---|---|
| Codex | 0.144.6 | `codex-app-server-v2` | não (Codex `exec-server` experimental) |
| Claude Code | 2.1.280 | `claude-stream-json-v1` | sim, via MCP |
| AGY | 1.2.10, 1.2.11 | `agy-stream-json-v1` | não (sem MCP por sessão nem aprovação headless) |

A matriz vive em `src/agents/core/versions.ts` e significa **protocolo verificado contra o
binário real** (fixtures em `test/fixtures/agents/contracts/`, capturadas sem consumir
cota). A validação ponta a ponta com turnos reais (`npm run test:agents:real`) é um gate
manual antes de produção e ainda está pendente para todas as versões. O AGY se atualiza
sozinho: a 1.2.11 chegou durante o ciclo, foi detectada como não certificada e entrou na
matriz após repetir as sondagens de protocolo.
