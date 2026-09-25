# Modelo de ameaças

Data da revisão: 27/07/2026. Escopo: gateway, adaptador de upstream, adaptadores
HTTP nativos Codex/Claude, camada de tradução, fluxo OAuth e container. O
computador do agente cliente não foi alterado nem testado neste ciclo.

Reescrito pela migração de broker CLI (subprocessos Bubblewrap) para adaptadores
HTTP nativos — ver [ADR-016](../../adr/ADR-016-substituicao-do-broker-por-adaptadores-http.md),
[ADR-017](../../adr/ADR-017-fim-do-regime-sintetico-de-sse.md) e
[ADR-018](../../adr/ADR-018-credencial-oauth-da-assinatura.md). A superfície de
subprocesso, Bubblewrap e socket Unix **deixou de existir**; em seu lugar nasce a
superfície de dois upstreams adicionais com segredos próprios (tokens OAuth) e uma
camada de tradução que manipula conteúdo do usuário em código do gateway.

Revisão de 25/09/2026: acrescenta o **Agent Plane** (`azigate-agentd`, workers e ponte
MCP) — ver [ADR-022](../../adr/ADR-022-agent-plane-nativo.md),
[ADR-023](../../adr/ADR-023-worker-remoto-e-isolamento-de-workspace.md) e
[ADR-024](../../adr/ADR-024-persistencia-de-sessoes-e-dependencias-do-agent-plane.md) e a
seção [Agent Plane](#agent-plane) abaixo. As seções anteriores continuam válidas para o
Model Plane.

## Ativos

- chave do upstream, chaves Bearer do gateway e tokens OAuth (access + refresh) de
  Codex e Claude;
- prompts, código-fonte, tool arguments, resultados e respostas;
- repositórios no computador do agente cliente;
- disponibilidade e cotas dos provedores (upstream, Codex, Claude).

## Fronteiras de confiança

1. Agente cliente -> Nginx/gateway: rede não confiável, protegida por TLS, Bearer, allowlists e limites.
2. Gateway -> upstream: HTTPS para base e paths fixos, com credencial reconstruída.
3. Gateway -> Anthropic (Messages API): HTTPS, path fixo `/v1/messages`, `Authorization: Bearer <token OAuth>` reconstruído pelo `AnthropicClient`.
4. Gateway -> Codex (Responses API): HTTPS, path fixo `/responses`, `Authorization: Bearer <token OAuth>` e `Chatgpt-Account-Id` reconstruídos pelo `CodexClient`.
5. Gateway -> arquivo de token OAuth: leitura/escrita local `0600`, nunca logado, nunca montado em outro processo.
6. Agente cliente -> repositório: única fronteira com capacidade de leitura, shell e edição, sujeita à confirmação do usuário.

## Ameaças e controles

| Ameaça | Impacto | Controle implementado | Evidência |
|---|---|---|---|
| Proxy aberto/SSRF | acesso a hosts internos ou terceiros | quatro rotas públicas; registry fechado; base/paths de todos os adaptadores fixos, nenhum aceita URL/path do cliente | testes de rotas, registry e clientes HTTP |
| Confusão de provedor/fallback | envio de dados ao provedor errado | aliases reservados e sem fallback automático; os prefixos `codex-cli`/`claude-cli` são reservados, então um alias desconhecido ou removido do catálogo recebe `400 invalid_model` em vez de seguir para o upstream (ADR-021) | testes de roteamento, catálogo e alias removido |
| Roubo/substituição de credencial | uso indevido ou vazamento | Bearer local, comparação constante, `Authorization` reconstruída por adaptador a partir do seu próprio segredo — a credencial do cliente nunca segue adiante | testes de auth e dos clientes HTTP |
| Vazamento/uso indevido do token OAuth da assinatura | controle da conta Codex/Claude do operador | arquivo `0700`/`0600`, fora do container versionado, nunca logado; renovação automática sob demanda; falha de login vira `oauth_not_logged_in` sem fallback | testes de `token-store`, `codex-oauth`, `claude-oauth` |
| Detecção de cliente não-oficial pela Anthropic | bloqueio/limitação da conta ao usar o token OAuth fora do Claude Code oficial | **risco aceito e não mitigado por evasão**: o gateway não reproduz fingerprint/cloaking do cliente oficial (ver adendo do ADR-018); falha aparece como `anthropic_upstream_error` | ADR-018, sem gate automatizado — validar na Fase 8 |
| Prompt injection solicitando host/shell | leitura ou alteração do servidor | Codex/Claude só recebem texto/tool schemas via HTTP; nenhuma ferramenta local, nenhum subprocesso, nenhum acesso a filesystem do host | testes de tradução e de roteamento |
| Injeção de comando | execução arbitrária no servidor | não existe mais subprocesso, `spawn`, argv ou shell no caminho de requisição — a garantia é estrutural, não uma sandbox | ausência de qualquer chamada a `child_process` em `src/` |
| Abuso de effort/modelo CLI | custo ou argumento inesperado | aliases fechados; modelo interno e effort normalizados em `src/providers/reasoning-effort.ts` antes de qualquer chamada HTTP | testes de `reasoning-effort` |
| Saída maliciosa/alucinação de tool | o agente executa ação não oferecida | nomes de tool validados contra a allowlist da requisição; argumentos JSON parseados com fallback seguro (`{}`); IDs vêm do provedor | testes de tradução (tool_use/function_call) |
| DoS por corpo grande | exaustão de memória | `MAX_REQUEST_BODY_BYTES` no Fastify; leitor de SSE limita o buffer de linha a 50 MB e o descarta se excedido | `sse-reader.ts` e testes |
| Persistência indevida de conteúdo | exposição após restart | gateway stateless por requisição; nenhum transcript, prompt ou resposta é persistido em disco ou log | revisão de `cli-completion.ts` e observability |
| Telemetria de usage incorreta | diagnóstico/custo enganoso | tradutores por provedor mapeiam `usage` explicitamente (cache/reasoning como subconjunto ou parcela conforme o provedor) | testes de tradução de usage |
| Correlação de conversas via `prompt_cache_key` | agrupamento indevido de chamadores distintos no roteamento de cache | chave é digest SHA-256 truncado da âncora da conversa e dos nomes de ferramenta, nunca do conteúdo em claro; jamais registrada em log; omitida quando não há âncora; o cache do fornecedor é escopado à conta OAuth, que já é única por construção (ADR-018, ADR-020) | testes de `prompt_cache_key` em `translation-openai-to-responses` e na integração CLI |
| Vazamento em logs/erros | exposição de secrets e código | sem bodies/prompts/tokens; erros de provedor viram códigos genéricos (`codex_upstream_error`, `anthropic_upstream_error`) sem repassar o corpo bruto do provedor | testes de sanitização e de erro |
| Buffering/SSE inconsistente | cliente travado ou resposta inválida | upstream byte a byte; Codex/Claude streaming incremental real evento a evento, sem heartbeat artificial | testes dos três regimes SSE |
| Mudança de contrato das APIs do provedor | falha silenciosa de tradução | Messages/Responses são APIs versionadas e estáveis (ao contrário das flags internas do broker anterior); mudanças de shape são pegas pelos testes de tabela da camada de tradução | suíte `test/translation-*.test.ts` |
| Mudança do fluxo OAuth (client_id/endpoint não documentados oficialmente) | perda de acesso ou comportamento inesperado | lógica de OAuth isolada por provedor em `src/providers/oauth/`; falha vira `oauth_refresh_failed`/`oauth_token_exchange_failed` sem fallback silencioso; o log registra só o status HTTP e o código OAuth por allowlist (nunca `error_description` ou token) | testes de `codex-oauth`/`claude-oauth`/`oauth-http-error` contra mock |
| Supply chain/container | execução vulnerável | lockfile, `npm ci`, imagem pinada, processo não root e audit | build, audit e smoke local |

## Risco residual

- O protocolo OpenAI-compatible do agente cliente e as APIs Messages/Responses são
  interfaces evolutivas; mudanças de contrato exigem atualizar a camada de
  tradução e seus testes de tabela.
- O fluxo OAuth (client_id, endpoints, PKCE) reproduz comportamento observado das
  CLIs oficiais, não uma API pública documentada e versionada — pode mudar sem
  aviso, como as flags internas que motivaram a migração original.
- Para o Claude, o gateway autentica com a assinatura do operador sem reproduzir
  fingerprint/cloaking do cliente oficial. Isso pode ser detectado pela Anthropic
  como uso não-oficial e resultar em bloqueio, limitação ou suspensão da conta —
  risco aceito explicitamente pelo dono do projeto (ADR-018), não eliminado.
- Usar a assinatura de um produto para autenticar um cliente não oficial pode
  conflitar com os termos de uso do fornecedor, mesmo com reprodução de protocolo
  tecnicamente equivalente à da CLI oficial.
- Rate limit e cache continuam locais a uma instância.
- A porcentagem das cotas Claude/Codex aplica pesos não expostos. Tokens lógicos
  não garantem equivalência com a UI do plano.
- O smoke completo com um cliente OpenAI-compatible real (tools, streaming,
  multi-turn) depende de execução manual e permanece pendente até a Fase 8 da
  migração ser concluída pelo operador.

## Agent Plane

Diferença fundamental: no Model Plane nada é executado no servidor; no Agent Plane o
agente nativo **executa ferramentas** — no host A (workspace local) ou na máquina B (via
worker). O controle deixa de ser "ausência de execução" e passa a ser "execução
confinada, autorizada e aprovada".

### Ativos adicionais

- chaves `AGENT_API_KEYS`, `WORKER_TOKEN_SECRET` e tokens de worker;
- tokens de capacidade MCP por sessão;
- login das CLIs no HOME do usuário do agentd (gerido pelas CLIs, nunca lido pelo Azigate);
- repositórios configurados como workspaces (host A e máquina B);
- banco `agentd.db` (metadados) e eventos em memória (conteúdo).

### Fronteiras

1. Cliente de agentes → Nginx → agentd: TLS, Bearer do Agent Plane, allowlist, rate limit.
2. agentd → CLIs (Codex, Claude, AGY): subprocessos no host A.
3. azigate-worker (B) → agentd: WebSocket de saída autenticado por token HMAC.
4. Claude → azigate-mcp-bridge → agentd: stdio e socket Unix privado.
5. Worker → sistema de arquivos e processos da máquina B.

### Ameaças e controles

| Ameaça | Impacto | Controle implementado | Evidência |
|---|---|---|---|
| Reuso de credencial entre planos | acesso a agentes com a chave de modelos | três credenciais disjuntas; o startup falha se `AGENT_API_KEYS` repetir `GATEWAY_API_KEYS` ou o segredo de worker | `agent-config-security.test.ts`, `agentd.integration.test.ts` |
| BOLA/IDOR em sessões e aprovações | ler eventos, aprovar ou cancelar sessão alheia | recursos pertencem à credencial criadora; outra recebe `404` | `agent-sessions.test.ts`, `agentd.integration.test.ts` |
| Path traversal / workspace arbitrário | agente atuando em `/etc`, `~/.ssh` | cliente só informa ID; paths vêm do operador; worker faz `realpath` e checa prefixo; recusa absoluto, `~`, byte nulo e symlink para fora; `delete` não segue symlink | `worker-ops.test.ts` |
| Injeção de flag/comando nas CLIs | desligar permissões, executar comando | argv montado em código; `model` e IDs nativos validados (não começam com `-`); `spawn` sem shell; nunca `--dangerously-skip-permissions`/`bypassPermissions`/`danger-full-access` | `agents-providers.test.ts` |
| Ferramentas locais do host A em sessão remota | agente lendo/alterando a máquina errada | Claude com `--tools ""`, `--strict-mcp-config`, cwd vazio e privado | `agents-providers.test.ts` |
| JSON-RPC arbitrário no Codex via endpoint nativo | `command/exec`, `fs/writeFile`, `account/logout` no host A | `WS /native` somente de saída; mensagens do cliente ignoradas | `agentd.integration.test.ts` |
| Execução de código via configuração do Git | `git status` rodando fsmonitor/filtros escritos pelo agente | `.git` imutável pelo agente; fsmonitor, hooks, diff externo e textconv desligados; `GIT_CEILING_DIRECTORIES` | `worker-ops.test.ts` |
| Execução remota abusiva | comando destrutivo na máquina B | execução desligada por padrão; allowlist de `argv[0]`; sem shell; aprovação no agente; timeout, limite de saída e de processos | `worker-ops.test.ts` |
| Worker impostor ou fora de escopo | expor workspace não autorizado | token HMAC com `workerId`, escopos e expiração; registro com outro ID recusado; conexão encerrada na expiração | `agent-workers-mcp.test.ts`, `agentd.integration.test.ts` |
| Uso da ponte MCP por outro processo | acesso ao worker sem sessão | socket `0600` (criado com `umask 0177`), token aleatório por sessão revogado no fim; `mcp-config.json` `0600` em diretório `0700`, nunca em argv | `agentd.integration.test.ts` |
| Aprovação indevida | ação sem consentimento | qualquer desfecho que não seja `allow` explícito nega (expiração, cancelamento, reinício) | `agent-sessions.test.ts` |
| Vazamento de conteúdo | prompts, código e dados da conta em disco/log | banco só com metadados; eventos só em memória e só para o dono; handshake do Claude (e-mail/organização) nunca vira evento; logs só com IDs e códigos; stderr das CLIs apenas contado | `agent-sessions.test.ts`, `agents-providers.test.ts` |
| Segredos herdados pelas CLIs | CLI ou ferramenta lendo chaves do gateway | ambiente mínimo por allowlist, sem `*_API_KEYS`, `WORKER_TOKEN_SECRET` ou `DEEPSEEK_API_KEY` | `agent-config-security.test.ts` |
| DoS por processo, saída ou evento | memória/CPU do host | limites global e por provider, timeout de turno e ociosidade, linha NDJSON ≤ 16 MiB, buffer de eventos por quantidade e bytes, `O_NONBLOCK` contra FIFO | testes de núcleo, sessões e worker |
| Retomada que perde contexto | agente seguindo sem histórico em silêncio | AGY: `conversation_id` do `init` comparado ao pedido; Codex/Claude: erro de retomada vira sessão `failed` | `agents-providers.test.ts` |
| Protocolo nativo mudar | eventos perdidos ou mal interpretados | matriz certificada com `fail-closed` em produção; contract tests por versão; `provider.event` preserva o desconhecido | `agents-contracts.test.ts` |

### Risco residual

- Workspaces locais dão ao agente os privilégios do usuário do agentd, limitados pelo
  sistema de permissões da própria CLI e pelas aprovações. Recomenda-se um usuário
  dedicado.
- A jail do worker protege operações de arquivo, não o efeito de um programa permitido:
  com `exec.enabled`, um comando aprovado roda com os privilégios do usuário do worker.
- Condições de corrida (TOCTOU) entre a verificação de `realpath` e a operação são
  mitigadas por `O_NOFOLLOW` no último componente, não eliminadas.
- O formato interno do `step_update` do AGY foi inferido do changelog oficial; a suíte
  manual `test:agents:real` é o gate de validação.
- AGY headless não tem canal de aprovação: o modo `review` equivale a negar o que exigiria
  revisão.
- `node:sqlite` é experimental no Node 22.
- Rate limit, buffer de eventos e aprovações continuam locais a uma instância.

