# Módulo Agent Plane

O Agent Plane é o serviço `azigate-agentd`, separado do gateway de modelos, que opera
Codex, Claude Code e Google Antigravity CLI (AGY) como **agentes completos**, pelo
protocolo nativo de cada um ([ADR-022](../../../adr/ADR-022-agent-plane-nativo.md)). Os três
rodam na máquina A e podem trabalhar sobre um projeto que continua na máquina B, através do
[Workspace Server](../workspace/index.md) via MCP
([ADR-025](../../../adr/ADR-025-workspace-server-mcp-para-os-tres-agentes.md)).

```text
MÁQUINA B                                   MÁQUINA A
azigate-agent (cliente) ──HTTPS/SSE──────► azigate-agentd
                                             ├── codex app-server  ─┐
                                             ├── claude -p          ├─ MCP ─► ponte ─► relay
                                             └── agy                ─┘                   │
azigate-workspace (servidor MCP) ◄──────── WS de saída iniciado por B ◄────────────────┘
     └── projeto
```

| Plano | Processo | Estado | Executor de ferramentas |
|---|---|---|---|
| Model Plane | `azigate` (`dist/server.js`) | stateless | o agente cliente (Qwen, Cline…) no computador dele |
| Agent Plane | `azigate-agentd` (`dist/agentd/server.js`) | sessões em SQLite | Claude Code, Codex ou AGY, sobre o workspace escolhido por ID |

## Features

- [Serviço `azigate-agentd`](./agentd.md) — configuração, credenciais, rotas, limites e startup.
- [Sessões e turnos](./sessions.md) — ciclo de vida, suspensão, retomada e persistência.
- [Eventos e endpoint nativo](./events.md) — eventos universais, SSE e `WS /native`.
- [Aprovações](./approvals.md) — pedidos de permissão nativos como entidade do Azigate.
- [Provider Codex](./codex-agent.md) — `codex app-server`.
- [Provider Claude Code](./claude-agent.md) — `claude -p` em `stream-json`.
- [Provider AGY](./agy-agent.md) — `agy` headless em `stream-json`.
- [Workspace remoto](./remote-workspace.md) — Claude, Codex e AGY em A sobre o projeto em B.
- [Cliente `azigate-agent`](./agent-client.md) — chat de terminal para a máquina B.
- [Workspace Server](../workspace/index.md) — o componente da máquina B (módulo próprio).

## Código

| Pasta | Responsabilidade |
|---|---|
| `src/agents/core/` | contrato `AgentProvider`, eventos universais, registry, processo, NDJSON, JSON-RPC, versões |
| `src/agents/{codex,claude,agy}/` | adaptadores nativos e mapeamento de eventos |
| `src/agent-control/` | `SessionService`, aprovações, buffer de eventos, `SessionStore`, workspaces, `WorkerHub`, ferramentas remotas |
| `src/agentd/` | serviço Fastify, config, rotas, socket MCP e gerador de token de worker |
| `src/agentd/mcp-bridge/` | executável `azigate-mcp-bridge` (ponte stdio → relay) |
| `src/agent-client/` | executável `azigate-agent` |
| `src/workspace/` | Workspace Server (ver [módulo](../workspace/index.md)) |

## Contratos e decisões

- [Contrato do Agent Plane](../../../specs/agent-api.md) e [OpenAPI](../../../specs/agent-openapi.yaml)
- [Protocolo do Workspace Server e da ponte MCP](../../../specs/workspace-protocol.md)
- [ADR-022](../../../adr/ADR-022-agent-plane-nativo.md),
  [ADR-023](../../../adr/ADR-023-worker-remoto-e-isolamento-de-workspace.md),
  [ADR-024](../../../adr/ADR-024-persistencia-de-sessoes-e-dependencias-do-agent-plane.md),
  [ADR-025](../../../adr/ADR-025-workspace-server-mcp-para-os-tres-agentes.md)
- [Runbook de operação](../../operations/agent-plane.md)
- [Plano rastreável](../../../tasks/native-agent-plane-plan.md)

## Matriz certificada

| Provider | Versão certificada | Protocolo | Workspace remoto |
|---|---|---|---|
| Codex | 0.144.6 | `codex-app-server-v2` | sim, MCP via `-c` |
| Claude Code | 2.1.280 | `claude-stream-json-v1` | sim, MCP via `--mcp-config` |
| AGY | 1.2.10, 1.2.11 | `agy-stream-json-v1` | sim, MCP global + agente `azigate-workspace` |

A matriz vive em `src/agents/core/versions.ts` e significa **protocolo verificado contra o
binário real** (fixtures em `test/fixtures/agents/contracts/`, capturadas sem consumir
cota). A validação ponta a ponta com turnos reais (`npm run test:agents:real`) é um gate
manual antes de produção e ainda está pendente para todas as versões. O AGY se atualiza
sozinho: a 1.2.11 chegou durante o ciclo, foi detectada como não certificada e entrou na
matriz após repetir as sondagens de protocolo.
