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

Este é o `azigate`, um gateway stateless em Node.js/TypeScript com Fastify e Undici. O agente cliente OpenAI-compatible (por exemplo Qwen Code, GitHub Copilot, Cline ou Continue) escolhe um provedor pelo `model`, mas continua sendo o único processo autorizado a executar ferramentas e alterar os repositórios do computador onde ele roda:

```text
Agente cliente -> HTTPS/Nginx -> Fastify
                              ├── HTTPS/upstream (DeepSeek por padrão)
                              └── Unix socket -> broker host -> Codex/Claude em Bubblewrap
```

O gateway é um monólito modular sem banco, fila ou frontend. O broker é um serviço host privado e isolado. Rate limit e cache de modelos são locais a cada processo.

Mapa principal:

- `src/config.ts`: leitura e validação de configuração e secrets;
- `src/security/`: autenticação e rate limit;
- `src/upstream/`: único adaptador autorizado a construir requisições para o upstream OpenAI-compatible configurado;
- `src/providers/`: registry fechado, cliente do broker, normalização CLI e respostas OpenAI/SSE;
- `src/broker/`: protocolo privado, checks de capacidade, prompt, isolamento e subprocessos;
- `src/models/`: cache e filtro da lista de modelos;
- `src/routes/`: health, readiness, models e chat completions;
- `src/http/`: erros HTTP e cancelamento do cliente;
- `src/observability/`: métricas e sanitização;
- `test/`: testes unitários/integração e upstream HTTP local simulado;
- `config/nginx/`: proxy TLS e streaming;
- `dist/` e `coverage/`: artefatos gerados; não editar manualmente.

## Invariantes obrigatórias

- A superfície HTTP permanece fechada a `GET /health`, `GET /ready`, `GET /v1/models` e `POST /v1/chat/completions`. Não crie proxy genérico nem aceite URL, host ou path upstream vindos do cliente.
- `codex-cli` e `claude-cli` são aliases reservados. Nunca faça fallback automático para o upstream ou entre provedores.
- O upstream usa apenas os paths tipados `models` e `chat/completions`, HTTPS em produção e `redirect: 'error'`.
- A credencial Bearer do gateway nunca segue para o upstream. Reconstrua `Authorization` exclusivamente com `DEEPSEEK_API_KEY` (a credencial do upstream) e mantenha allowlists explícitas de headers.
- Nunca registre prompts, mensagens, respostas, bodies, tool arguments, cookies, Authorization ou secrets. Erros públicos e respostas bufferizadas precisam continuar sanitizados.
- Não leia, imprima, versione ou inclua `.env` e arquivos de `secrets/` em saídas. Use `.env.example` para entender a configuração e valores fictícios nos testes.
- Preserve o passthrough opaco de campos OpenAI-compatible desconhecidos, inclusive `tools`, `tool_choice`, `reasoning_content` e campos futuros. A validação textual/function tool adicional vale somente para aliases CLI.
- Preserve o SSE do upstream incremental, keep-alives, usage e `data: [DONE]` sem remontar eventos. Para CLI, preserve o regime sintético documentado: heartbeat, decisão validada atômica e erro sem `[DONE]` depois do início.
- O agente cliente é o único executor. Codex/Claude não recebem cwd, repositório, home completo ou ferramentas locais; o broker recusa evento de execução e nunca interpreta texto como patch.
- O protocolo do broker aceita somente request ID, provider, mensagens e ferramentas normalizadas. Não acrescente comando, argv, ambiente, URL ou path fornecidos pelo cliente.
- Subprocessos do broker usam `spawn` sem shell, argv fixo, ambiente mínimo, grupo de processos, limite de tempo/saída, concorrência global 1 sem fila e Bubblewrap.
- Preserve status e respostas seguras do upstream. Retentativas só podem ocorrer antes do início da resposta e devem continuar limitadas aos status configurados.
- Altere limites de body, timeouts e comportamento de proxy de forma coerente entre aplicação, Compose, Nginx e documentação.
- Não transforme cache ou rate limit local em garantia distribuída sem novo backend e decisão arquitetural explícita.

## Convenções de implementação

- Requer Node.js `>=20.18.1`; CI e imagem usam Node.js 22.
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

A cobertura mínima é 80% para linhas, funções e statements, e 70% para branches. Testes automatizados não devem chamar o upstream, Codex ou Claude reais: use `createTestConfig`, `test/mock-upstream.ts`, executáveis falsos e broker mockado. Os scripts `gate:codex`/`gate:claude` são validações manuais explícitas e nunca pertencem à suíte comum. Toda correção de bug ou mudança observável deve incluir teste de regressão, especialmente para autenticação, sanitização, allowlists, roteamento, protocolo interno, saída CLI, streaming e cancelamento.

Quando houver mudança de infraestrutura, valide adicionalmente o artefato afetado, por exemplo `docker compose config`, `docker build` ou `nginx -t` em ambiente apropriado.

## Critério de conclusão

Uma tarefa só está concluída quando código, testes, contratos e documentação estão coerentes; nenhum secret ou dado sensível foi exposto; e os gates proporcionais ao risco foram executados ou a impossibilidade foi registrada claramente.
