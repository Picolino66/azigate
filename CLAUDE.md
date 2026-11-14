# Instruções para agentes

## Escopo e idioma

Este arquivo vale para todo o repositório. Mantenha documentação, mensagens de erro e comunicação operacional em português. Preserve nomes de APIs, identificadores de código e termos de protocolo no idioma original quando isso evitar ambiguidade.

## Fluxo docs-first

1. Comece sempre por `docs/index.md`; trate `/docs` como a fonte primária de contexto.
2. Identifique o módulo afetado e leia a documentação correspondente antes de abrir o código. Consulte também `docs/architecture.md`, `specs/gateway-api.md`, `specs/openapi.yaml`, os ADRs e os documentos de segurança quando forem relevantes.
3. Use o código para validar detalhes ausentes ou divergentes. Não altere comportamento silenciosamente quando documentação e implementação discordarem; explicite e resolva a inconsistência no mesmo trabalho.
4. Depois de mudar comportamento, contrato, entrada, saída, dependência, regra ou fluxo, atualize a documentação correspondente e seus índices.
5. Documentação nova de módulo/feature deve ficar em `docs/modules/<modulo>/`, com um `index.md` do módulo e um arquivo por feature contendo: descrição, localização no código, entrada, saída, dependências, regras de negócio, fluxo resumido e possíveis erros.

Atualize também:

- `specs/gateway-api.md` e `specs/openapi.yaml` quando o contrato HTTP mudar;
- `README.md` e `.env.example` quando configuração ou operação mudar;
- um ADR quando houver decisão arquitetural duradoura;
- o threat model e documentos de segurança quando fronteiras de confiança ou controles mudarem.

Valide links internos da documentação alterada.

## Orquestração obrigatória

- Use a skill `$autonomous-software-orchestrator` como coordenadora principal em tarefas de planejamento, implementação, evolução de features, revisão arquitetural, qualidade, deploy ou resposta a incidentes. Leia integralmente `~/.agents/skills/autonomous-software-orchestrator/SKILL.md` e as referências exigidas pela skill antes de agir.
- Depois de `docs/index.md`, leia `docs/orchestrator-context.json` e trate seu `OrchestratorContext` como estado canônico compartilhado. Não execute uma skill especialista sem fornecer a ela esse contexto atualizado.
- Escolha o modo proporcional ao trabalho: `feature-evolution` para features no sistema existente, `architecture-review` para reavaliações, `incident-response` para incidentes, `phase-resume` para retomar um snapshot e `full-pipeline` somente quando todo o ciclo de criação for realmente necessário.
- Respeite dependências entre fases e não marque quality gates como aprovados sem evidência. Registre no contexto gates executados, falhas, skills externas ativadas e o último snapshot estável aplicável.
- Registre decisões arquiteturais duradouras em ADR, com contexto, alternativas, decisão, trade-offs e consequências. Implementação, testes, contratos e documentação devem permanecer rastreáveis a requisitos e ADRs.
- Antes de usar uma sub-skill interna, procure uma skill externa mais especializada, priorizando `.agents/skills/`, depois `~/.agents/skills/` e `~/.claude/skills/`. Use-a como substituta ou complementar conforme a cobertura e consolide seu resultado no contexto sem contrariar decisões existentes.
- Paralelize apenas trabalhos independentes, sem permitir edição concorrente da mesma seção ou artefato. Resolva conflitos antes de incorporar os resultados e nunca pule gates por urgência.

## Contexto do projeto

Este é o `azigate`, com dois planos em processos separados ([ADR-022](adr/ADR-022-agent-plane-nativo.md)):

- **Model Plane** (`azigate`): gateway stateless em Node.js/TypeScript com Fastify e Undici. O agente cliente OpenAI-compatible (por exemplo Qwen Code, GitHub Copilot, Cline ou Continue) escolhe um provedor pelo `model`, mas continua sendo o único processo autorizado a executar ferramentas e alterar os repositórios do computador onde ele roda.
- **Native Agent Plane** (`azigate-agentd`): serviço stateful que opera Codex, Claude Code e Google Antigravity (AGY) como agentes completos, pelo protocolo nativo de cada CLI, com sessões, eventos e aprovações. Os três podem operar um projeto em outra máquina pelo **Workspace Server** (`azigate-workspace`, antigo `azigate-worker`) via MCP ([ADR-025](adr/ADR-025-workspace-server-mcp-para-os-tres-agentes.md)).

Princípio: o Model Plane permite que agentes locais usem modelos remotos; o Native Agent Plane permite que agentes remotos completos usem ambientes de execução locais.

```text
Agente cliente -> HTTPS/Nginx -> azigate (Fastify)
                                  ├── HTTPS/upstream (DeepSeek por padrão)
                                  ├── HTTPS/Anthropic Messages API (model adapters claude-cli-*)
                                  └── HTTPS/Responses API do Codex (model adapters codex-cli-*)

Cliente de agentes -> HTTPS/Nginx -> azigate-agentd (host A)
                                      ├── stdio -> codex app-server | claude -p | agy
                                      │            └── MCP -> azigate-mcp-bridge -> relay (socket Unix)
                                      └── WebSocket de saída <- azigate-workspace (máquina do projeto)
```

O Model Plane é um monólito modular sem banco, fila ou frontend. O Agent Plane guarda somente metadados de sessão em SQLite. Rate limit, caches, eventos e aprovações são locais a cada processo.

Mapa principal:

- `src/config.ts`: leitura e validação de configuração e secrets do Model Plane;
- `src/security/`: autenticação e rate limit;
- `src/upstream/`: único adaptador autorizado a construir requisições para o upstream OpenAI-compatible configurado;
- `src/providers/`: registry fechado, clientes HTTP Anthropic/Codex (model adapters), OAuth da assinatura e driver de streaming;
- `src/translation/`: conversores puros OpenAI ↔ Messages/Responses;
- `src/models/`: cache e filtro da lista de modelos;
- `src/routes/`: health, readiness, models e chat completions;
- `src/http/`: erros HTTP e cancelamento do cliente;
- `src/observability/`: métricas e sanitização;
- `src/agents/`: núcleo do Agent Plane e adaptadores nativos Codex, Claude Code e AGY;
- `src/agent-control/`: sessões, aprovações, eventos, `SessionStore`, `WorkerHub` e `WorkspaceRelay`;
- `src/agentd/`: serviço `azigate-agentd` e a ponte `azigate-mcp-bridge` (`src/agentd/mcp-bridge/`);
- `src/workspace/`: Workspace Server da máquina do projeto (`protocol`, `mcp`, `filesystem`, `process`, `git`, `security`, `server`); `src/worker/main.ts` é só o alias do nome antigo;
- `src/agent-client/`: cliente de terminal `azigate-agent`;
- `src/vscode-extension/`: extensão VS Code da máquina B (painel de agentes e controle do Workspace Server; só `extension.ts` importa `vscode`; `npm run pack:vscode`, [ADR-028](adr/ADR-028-extensao-vscode-maquina-b.md));
- `tools/`: empacotamento do `azigate-client` (Workspace Server + `azigate-agent` em arquivo único para a máquina B; `npm run pack:client`);
- `test/`: testes unitários/integração, upstream HTTP local simulado e CLIs de agente falsas (`test/fixtures/agents/`);
- `config/nginx/` e `config/systemd/`: proxy TLS/streaming/WebSocket e unidade do agentd;
- `dist/`, `dist-client/`, `dist-vscode/` e `coverage/`: artefatos gerados; não editar manualmente.

## Invariantes obrigatórias

### Gerais

- Nunca registre prompts, mensagens, respostas, bodies, tool arguments, saída de shell, código, cookies, Authorization, tokens ou secrets. Erros públicos e respostas bufferizadas precisam continuar sanitizados.
- Não leia, imprima, versione ou inclua `.env` e arquivos de `secrets/` em saídas. Use `.env.example` para entender a configuração e valores fictícios nos testes.
- Altere limites de body, timeouts e comportamento de proxy de forma coerente entre aplicação, Compose, Nginx, systemd e documentação.
- Não transforme cache, rate limit, eventos ou aprovações locais em garantia distribuída sem novo backend e decisão arquitetural explícita.
- Model Plane e Agent Plane não importam rotas, credenciais nem estado um do outro (regras `no-restricted-imports` do `eslint.config.js`; só `config`, `security` e `observability` são comuns). `GATEWAY_API_KEYS`, `AGENT_API_KEYS` e `WORKER_TOKEN_SECRET` são sempre disjuntos.

### Model Plane (`azigate`)

- A superfície HTTP permanece fechada a `GET /health`, `GET /ready`, `GET /v1/models` e `POST /v1/chat/completions`. Não crie proxy genérico nem aceite URL, host ou path upstream vindos do cliente.
- `codex-cli` e `claude-cli` são prefixos reservados de model adapters. Nunca faça fallback automático para o upstream ou entre provedores.
- Cada adaptador (upstream, Anthropic Messages, Codex Responses) usa apenas paths tipados e fechados, HTTPS em produção e `redirect: 'error'` ([ADR-016](adr/ADR-016-substituicao-do-broker-por-adaptadores-http.md)).
- A credencial Bearer do gateway nunca segue adiante. Cada adaptador reconstrói `Authorization` a partir do próprio segredo (`DEEPSEEK_API_KEY` no upstream; token OAuth da assinatura nos adaptadores Codex/Claude) e mantém allowlists explícitas de headers.
- Preserve o passthrough opaco de campos OpenAI-compatible desconhecidos, inclusive `tools`, `tool_choice`, `reasoning_content` e campos futuros.
- Preserve o SSE do upstream incremental, keep-alives, usage e `data: [DONE]` sem remontar eventos. Nos model adapters, preserve o streaming incremental real traduzido evento a evento; erro depois do início vira evento `error` sanitizado sem `[DONE]` ([ADR-017](adr/ADR-017-fim-do-regime-sintetico-de-sse.md)).
- O agente cliente é o único executor: nenhum subprocesso, ferramenta ou filesystem do servidor entra no caminho de `/v1` ([ADR-006](adr/ADR-006-qwen-como-unico-executor.md)).
- Preserve status e respostas seguras do upstream. Retentativas só podem ocorrer antes do início da resposta e devem continuar limitadas aos status configurados.

### Agent Plane (`azigate-agentd`, Workspace Server e ponte MCP)

- A superfície do agentd é `GET /health`, `GET /ready`, `/agent/v1/*`, `WS /native/:provider/:sessionId` (somente saída) e `WS /worker/v1/connect`. Contrato em `specs/agent-api.md` e `specs/workspace-protocol.md`.
- Use o protocolo nativo de cada CLI (`codex app-server`, `claude -p` em `stream-json`, `agy` em `stream-json`). Nunca converta eventos de agente para Chat Completions; sempre anexe a mensagem original em `native` e transforme o que não tiver mapeamento em `provider.event`.
- Nunca leia, copie, renove ou armazene credenciais das CLIs; a autenticação é da CLI oficial.
- O cliente escolhe workspace e worker apenas por ID. Nunca aceite `cwd`, path, comando, argv, ambiente ou URL vindos do cliente; paths vêm de `AGENT_WORKSPACES_FILE` ou da configuração do Workspace Server.
- Subprocessos usam `spawn` sem shell, argv montado em código com valores validados (nada começando com `-`), ambiente mínimo por allowlist, grupo de processos, término escalonado e limites de linha, tempo e sessões.
- Nunca use `--dangerously-skip-permissions`, `bypassPermissions`, `danger-full-access` ou `approvalPolicy: never`. Aprovação só vale com `allow` explícito do dono; qualquer outro desfecho nega.
- `WS /native` nunca repassa mensagens do cliente à CLI. Recursos pertencem à credencial que os criou; outra credencial recebe `404`.
- O banco guarda somente metadados; eventos e aprovações ficam só em memória ([ADR-024](adr/ADR-024-persistencia-de-sessoes-e-dependencias-do-agent-plane.md)).
- O Workspace Server conecta de saída (`wss://` fora de loopback), lê o token só de arquivo `0600`, aplica jail por `realpath`, protege `.git`, usa Git endurecido, mantém execução desligada por padrão (argv sem shell e allowlist quando ligada), nunca chama LLM e expõe o workspace como servidor MCP genérico ([ADR-023](adr/ADR-023-worker-remoto-e-isolamento-de-workspace.md), [ADR-025](adr/ADR-025-workspace-server-mcp-para-os-tres-agentes.md)).
- Claude, Codex e AGY operam a máquina do projeto somente pelas ferramentas MCP `azigate_workspace`, com cwd vazio da sessão e os recursos locais de A desligados (Claude: `--tools "Task,TodoWrite,WebFetch,WebSearch"` e `--strict-mcp-config`; Codex: shell, unified exec, navegador e computer use desligados, `sandbox: read-only`, pedidos nativos negados; AGY: agente `azigate-workspace` com `excludeDefaultComponents: true`). Nunca copie o projeto para A (clone, rsync, scp, sshfs).
- A máquina B recebe só o pacote `azigate-client` (nada do Model Plane nem do agentd) e a configuração do `client:setup` em `~/.config/azigate` (`0700`, arquivos `0600`). Segredos locais (token, `agent.key`) só são lidos de arquivos `0600`.
- A ponte MCP lê socket e token de `mcp-session.json` `0600` (`AZIGATE_MCP_SESSION`), nunca de argv; sem sessão, expõe zero ferramentas. O relay do agentd aplica o modo `plan` e cria as aprovações de Codex e AGY; o Claude usa `can_use_tool`.
- Nova versão de CLI só entra em `CERTIFIED_VERSIONS` com fixture de contrato capturada da própria versão e contract tests verdes. Antes de usar em produção, rode as suítes manuais `npm run test:agents:real` e `npm run test:agents:remote-real` e registre a evidência no contexto canônico.

## Convenções de implementação

- Requer Node.js `>=20.18.1`; CI e imagem usam Node.js 22. O `azigate-agentd` exige Node.js `>=22.13` (`node:sqlite`).
- O projeto usa ESM (`"type": "module"`) e resolução `NodeNext`. Imports locais TypeScript devem usar extensão `.js`.
- Preserve TypeScript estrito, incluindo `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` e `useUnknownInCatchVariables`.
- Use `import type` quando o import existir apenas no sistema de tipos. Não deixe promises sem tratamento.
- Siga o estilo existente: duas casas de indentação, aspas simples, sem ponto e vírgula e vírgula final em estruturas multilinha.
- Prefira mudanças pequenas no módulo responsável. Não duplique a construção do upstream fora de `src/upstream/`.
- Mantenha dependências fixadas e `package-lock.json` sincronizado. Não altere `node_modules/`.

## Testes e validação

Instale dependências de forma reproduzível:

```bash
npm ci --ignore-scripts
```

Durante a implementação, rode o menor teste relevante. Antes de concluir uma mudança de código, execute:

```bash
npm run check
```

Esse gate cobre lint, typecheck, testes e build. Para mudanças sensíveis ou amplas, rode também:

```bash
npm run test:coverage
npm audit --omit=dev --audit-level=high
```

A cobertura mínima é 80% para linhas, funções e statements, e 70% para branches. Testes automatizados não devem chamar o upstream, Codex, Claude ou AGY reais: use `createTestConfig`, `test/mock-upstream.ts`, as CLIs falsas de `test/fixtures/agents/` e os providers roteirizados de `test/helpers/`. Os scripts `test:agents:real`, `test:agents:remote-real` e `experiment:previous-response` são validações manuais explícitas e nunca pertencem à suíte comum. Toda correção de bug ou mudança observável deve incluir teste de regressão, especialmente para autenticação, sanitização, allowlists, roteamento, protocolo interno, protocolos nativos das CLIs, jail de workspace, aprovações, streaming e cancelamento.

Quando houver mudança de infraestrutura, valide adicionalmente o artefato afetado, por exemplo `docker compose config`, `docker build` ou `nginx -t` em ambiente apropriado.

## Critério de conclusão

Uma tarefa só está concluída quando código, testes, contratos e documentação estão coerentes; nenhum secret ou dado sensível foi exposto; e os gates proporcionais ao risco foram executados ou a impossibilidade foi registrada claramente.
