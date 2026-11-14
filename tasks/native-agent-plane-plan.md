# Plano rastreável — Native Agent Plane (`v2.md`)

## Contexto

O `v2.md` pede suporte nativo a Codex, Claude Code e AGY como agentes completos, sem
convertê-los para Chat Completions e sem alterar o Model Plane. As decisões estão em
[ADR-022](../adr/ADR-022-agent-plane-nativo.md),
[ADR-023](../adr/ADR-023-worker-remoto-e-isolamento-de-workspace.md) e
[ADR-024](../adr/ADR-024-persistencia-de-sessoes-e-dependencias-do-agent-plane.md) e
[ADR-025](../adr/ADR-025-workspace-server-mcp-para-os-tres-agentes.md);
os contratos em [agent-api.md](../specs/agent-api.md) e
[workspace-protocol.md](../specs/workspace-protocol.md).

Mapeamento das fases do `v2.md`: Fase 0 → NA-01; Fase 1 → NA-02 a NA-05; Fase 2 →
NA-06; Fase 3 → NA-07; Fase 4 → NA-08; Fase 5 → NA-09 e NA-10; Fase 6 → NA-11;
Fases 7 e 8 → NA-14. A correção de arquitetura de 25/09/2026 (Claude, Codex e AGY na máquina
A operando a máquina B) → NA-15 a NA-19.

## Estado em 25/09/2026

| Tarefa | Estado |
|---|---|
| NA-01 a NA-13 | implementadas; evidência no `OrchestratorContext` (`evolution_cycle`) |
| NA-14 | AGY remoto entregue por NA-17 (ADR-025); Codex `exec-server` continua não usado — o Codex remoto usa MCP |
| NA-15 a NA-20 | implementadas; evidência no `OrchestratorContext` (ciclo `native-agent-plane-workspace`) |
| Validação real remota (`npm run test:agents:remote-real`) | AGY 1.2.11 e Claude 2.1.280 aprovados; Codex 0.144.6 bloqueado pela credencial local do operador (`401`) |

## Tarefas

### Arquitetura e contratos

1. **NA-01 — Registrar as decisões do Agent Plane**
   - Objetivo: separar Model Plane e Agent Plane antes de qualquer código.
   - Escopo: ADR-022, ADR-023, ADR-024; invariantes por plano no `CLAUDE.md`/`AGENTS.md`.
   - Aceite: ADR-006 e ADR-001 restritos explicitamente ao Model Plane; nenhuma
     invariante do Model Plane alterada.

2. **NA-02 — Publicar os contratos do Agent Plane e do worker**
   - Escopo: `specs/agent-api.md`, `specs/agent-openapi.yaml`, `specs/workspace-protocol.md`.
   - Aceite: toda rota, evento, erro, modo de permissão e método RPC implementados
     aparecem no contrato com o mesmo nome.
   - Dependências: NA-01.

### Agent Core (backend)

3. **NA-03 — Implementar o núcleo de agentes**
   - Escopo: `src/agents/core/` — tipos `AgentProvider`/`AgentRuntimeSession`, eventos
     universais com `native`, registry fechado, leitor NDJSON limitado, gerenciador de
     processos sem shell e com grupo de processos, cliente JSON-RPC, matriz de versões.
   - Aceite: testes com executáveis falsos cobrem linha acima do limite, término
     escalonado, ambiente mínimo e argv sem shell.
   - Dependências: NA-02.

4. **NA-04 — Implementar controle de sessões, aprovações e eventos**
   - Escopo: `src/agent-control/` — `SessionService`, `ApprovalService`, buffer de eventos
     com replay, `SessionStore` SQLite e em memória, workspaces locais, limites,
     ociosidade, timeout de turno, recuperação no startup.
   - Aceite: limites global/por provider, `suspended` após ociosidade e reinício, retomada
     pela sessão nativa, aprovação expirada nega, nenhuma coluna de conteúdo no banco.
   - Dependências: NA-03.

5. **NA-05 — Expor o serviço `azigate-agentd`**
   - Escopo: `src/agentd/` — config, autenticação separada, rate limit, rotas REST, SSE,
     WebSocket nativo somente de saída, `/health`, `/ready`, entrypoint e desligamento.
   - Aceite: `AGENT_API_KEYS` disjunta de `GATEWAY_API_KEYS`; outra credencial recebe
     `404`; SSE com replay por `Last-Event-ID`; Model Plane intacto (suíte anterior verde).
   - Dependências: NA-04.

### Providers nativos

6. **NA-06 — Integrar AGY headless**
   - Escopo: `src/agents/agy/` — processo `stream-json`, `conversation_id`,
     `--conversation`, `--model`, `--effort`, `--mode`, usage, tools, subagentes,
     cancelamento por sinal.
   - Aceite: contract tests com fixtures de `init`/`result` capturadas da CLI 1.2.10.
   - Dependências: NA-05.

7. **NA-07 — Integrar Claude Code headless**
   - Escopo: `src/agents/claude/` — `stream-json` bidirecional, `--session-id`/`--resume`,
     `can_use_tool` → aprovação, `interrupt`, usage, subagentes.
   - Aceite: contract tests de `system/init`, `assistant`, tool use/result,
     `result` sucesso/erro, permissão, cancelamento e retomada.
   - Dependências: NA-05.

8. **NA-08 — Integrar Codex app-server**
   - Escopo: `src/agents/codex/` — `initialize`, `thread/start`, `thread/resume`,
     `turn/start`, `turn/interrupt`, notificações de item e usage, requisições de
     aprovação e recusa das demais requisições do servidor.
   - Aceite: contract tests com os métodos do schema oficial gerado pela CLI 0.144.6.
   - Dependências: NA-05.

### Worker e execução remota

9. **NA-09 — Implementar o protocolo e a identidade do worker**
   - Escopo: `src/worker-protocol/` (hoje `src/workspace/protocol/` e `src/workspace/security/`) — mensagens, validação, token HMAC com escopos e
     expiração, script `worker:token`.
   - Aceite: token adulterado, expirado, sem escopo ou de outro `workerId` é recusado.
   - Dependências: NA-02.

10. **NA-10 — Implementar o `azigate-worker` e o hub no agentd**
    - Escopo: `src/worker/` (jail por `realpath`, arquivos, Git endurecido, execução por
      argv desligada por padrão, cliente WebSocket com reconexão) e `WorkerHub` no agentd.
    - Aceite: traversal, symlink para fora, path absoluto e remoção da raiz recusados;
      heartbeat derruba worker silencioso; RPC ponta a ponta em teste de integração.
    - Dependências: NA-05, NA-09.

11. **NA-11 — Ligar Claude ao workspace remoto via MCP**
    - Escopo: `src/mcp-bridge/` (hoje `src/agentd/mcp-bridge/`), socket Unix privado no agentd, `mcp-config` `0600`,
      Claude com `--tools ""` e `--strict-mcp-config`.
    - Aceite: token de capacidade por sessão; `plan` recusa escrita/execução; nenhuma
      ferramenta local do host A habilitada.
    - Dependências: NA-07, NA-10.

### Qualidade, documentação e operação

12. **NA-12 — Documentar módulos, operação e segurança**
    - Escopo: `docs/modules/agents/`, arquitetura, threat model, inventário de
      endpoints, README, `.env.example`, Nginx, índices; aliases legados descritos como
      model adapters.
    - Aceite: links internos válidos; toda variável nova documentada.
    - Dependências: NA-05 a NA-11.

13. **NA-13 — Criar a suíte real manual `test:agents:real`**
    - Escopo: script que cria workspace temporário e executa tarefas inofensivas com cada
      provider habilitado; nunca roda na suíte comum.
    - Aceite: recusa rodar sem opt-in explícito e nunca aponta para projeto real.
    - Dependências: NA-06 a NA-08.

14. **NA-14 — AGY remoto e Codex `exec-server`**
    - AGY remoto: resolvido por NA-17 com MCP global + agente dedicado (ADR-025).
    - Codex `exec-server`: não usado; registro remoto experimental e acoplado à identidade
      OpenAI (ADR-023). O Codex remoto usa MCP (NA-16).

### Workspace Server para os três agentes (ADR-025)

15. **NA-15 — Workspace Server MCP e relay**
    - Escopo: `src/workspace/` (`protocol`, `mcp`, `filesystem`, `process`, `git`,
      `security`, `server`), binário `azigate-workspace` (alias `start:worker`), canais MCP no
      WebSocket, `WorkspaceRelay` com política e aprovações, ponte com `mcp-session.json`.
    - Aceite: servidor MCP genérico com anotações; `--mcp-stdio`; ponte sem sessão com zero
      ferramentas; `plan` e aprovações aplicados no relay.
    - Dependências: NA-10, NA-11.

16. **NA-16 — Codex remoto via MCP**
    - Escopo: recursos locais desligados, `mcp_servers.azigate_workspace`, demais servidores
      desligados, thread `read-only` com cwd vazio, pedidos nativos negados, elicitação.
    - Dependências: NA-08, NA-15.

17. **NA-17 — AGY remoto via MCP**
    - Escopo: `installAgyRemote`/`uninstallAgyRemote`, `AGY_REMOTE_AUTO_SETUP`,
      `npm run agy:remote`, `--agent azigate-workspace`, normalização de `call_mcp_tool`.
    - Dependências: NA-06, NA-15.

18. **NA-18 — Cliente `azigate-agent`**
    - Escopo: `src/agent-client/` — chat com cabeçalho (provider, host do agente, host e
      workspace), streaming, ferramentas, aprovação `y/N`, cancelamento, retomada.
    - Dependências: NA-05.

19. **NA-19 — Suíte comum e validação real remota**
    - Escopo: `test/workspace-compat.test.ts` (16 passos iguais para os três, Workspace
      Server em outro processo, fixture que só existe em B) e
      `test/manual/agents-remote-real.ts`.
    - Dependências: NA-15 a NA-18.

20. **NA-20 — Pacote da máquina B e configuração em um passo**
    - Escopo: `tools/client-package.ts` (`npm run pack:client`), `client:setup`,
      `~/.config/azigate` lido sem flags pelo Workspace Server e pelo `azigate-agent`.
    - Aceite: máquina B sem o repositório do Azigate; suíte comum com o pacote empacotado.
    - Dependências: NA-15, NA-18.
