# Plano rastreável — Native Agent Plane (`v2.md`)

## Contexto

O `v2.md` pede suporte nativo a Codex, Claude Code e AGY como agentes completos, sem
convertê-los para Chat Completions e sem alterar o Model Plane. As decisões estão em
[ADR-022](../adr/ADR-022-agent-plane-nativo.md),
[ADR-023](../adr/ADR-023-worker-remoto-e-isolamento-de-workspace.md) e
[ADR-024](../adr/ADR-024-persistencia-de-sessoes-e-dependencias-do-agent-plane.md);
os contratos em [agent-api.md](../specs/agent-api.md) e
[worker-protocol.md](../specs/worker-protocol.md).

Mapeamento das fases do `v2.md`: Fase 0 → NA-01; Fase 1 → NA-02 a NA-05; Fase 2 →
NA-06; Fase 3 → NA-07; Fase 4 → NA-08; Fase 5 → NA-09 e NA-10; Fase 6 → NA-11;
Fases 7 e 8 → NA-14 (adiadas com evidência).

## Estado em 25/09/2026

| Tarefa | Estado |
|---|---|
| NA-01 a NA-13 | implementadas; evidência no `OrchestratorContext` (`evolution_cycle`) |
| NA-14 | adiada: bloqueio técnico documentado no ADR-023 |
| Validação real (`npm run test:agents:real`) | pendente: exige execução manual do operador com as CLIs autenticadas |

## Tarefas

### Arquitetura e contratos

1. **NA-01 — Registrar as decisões do Agent Plane**
   - Objetivo: separar Model Plane e Agent Plane antes de qualquer código.
   - Escopo: ADR-022, ADR-023, ADR-024; invariantes por plano no `CLAUDE.md`/`AGENTS.md`.
   - Aceite: ADR-006 e ADR-001 restritos explicitamente ao Model Plane; nenhuma
     invariante do Model Plane alterada.

2. **NA-02 — Publicar os contratos do Agent Plane e do worker**
   - Escopo: `specs/agent-api.md`, `specs/agent-openapi.yaml`, `specs/worker-protocol.md`.
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
   - Escopo: `src/worker-protocol/` — mensagens, validação, token HMAC com escopos e
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
    - Escopo: `src/mcp-bridge/`, socket Unix privado no agentd, `mcp-config` `0600`,
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

14. **NA-14 — AGY remoto e Codex `exec-server` (adiada)**
    - Bloqueio: AGY sem MCP por sessão nem aprovação headless; registro remoto do Codex
      experimental e acoplado à identidade OpenAI (ADR-023).
    - Critério para retomar: CLI com contrato estável para ambos, registrado em novo ADR.
