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
| Confusão de provedor/fallback | envio de dados ao provedor errado | aliases reservados e sem fallback automático | testes de roteamento e catálogo |
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
| Mudança do fluxo OAuth (client_id/endpoint não documentados oficialmente) | perda de acesso ou comportamento inesperado | lógica de OAuth isolada por provedor em `src/providers/oauth/`; falha vira `oauth_refresh_failed`/`oauth_token_exchange_failed` sem fallback silencioso | testes de `codex-oauth`/`claude-oauth` contra mock |
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
