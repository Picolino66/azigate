# ADR-018 — Credencial: OAuth da assinatura para os adaptadores Anthropic e Codex

- Status: aceito
- Fase: migração F0 (decisão que precede a implementação)
- Data: 27/07/2026
- Depende de: ADR-016

## Contexto

A migração para adaptadores HTTP (ADR-016) precisa de uma credencial para autenticar contra
`api.anthropic.com` (Messages API) e `api.openai.com`/`chatgpt.com/backend-api/codex`
(Responses API via Codex). A camada de tradução é idêntica nos dois casos de credencial; muda
apenas de onde vem o token e para qual host o cliente se conecta.

O contexto canônico do projeto (`docs/orchestrator-context.json`, `product.business_rules` e
`requirements.constraints`) já registra, desde a introdução do broker (ADR-005/ADR-008), a
restrição "sem novas API keys Codex/Claude" e "aliases Codex dependem do login existente". Essa
restrição existia porque o modelo original era pessoal/LAN: o operador usa a própria assinatura
Codex/Claude já autenticada no host, não uma chave de API paga por uso separada.

O dono do projeto decidiu, antes desta ADR, que essa restrição deve continuar valendo na nova
arquitetura: a migração não deve introduzir a compra de API keys Anthropic/OpenAI pagas por
token; deve continuar autenticando com a assinatura já existente.

## Opções consideradas

- **Opção A — API key paga por uso** (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` convencionais,
  emitidas pelo console de cada fornecedor): mais simples de implementar — é o mesmo padrão já
  usado para o DeepSeek (`DEEPSEEK_API_KEY`) — e sem risco de violar termos de uso dos
  fornecedores. Rejeitada porque contraria a restrição de negócio já registrada
  ("sem novas API keys Codex/Claude") e reintroduz custo por token que o uso da assinatura
  evita.
- **Opção B — OAuth da assinatura, reproduzindo o fluxo das CLIs oficiais** (escolhida):
  reproduz o fluxo OAuth/PKCE que `codex-cli` e `claude` já usam para autenticar a assinatura do
  usuário — o mesmo caminho que o `CLIProxyAPI` (referência de estudo neste workspace, código
  Go não reaproveitado) implementa para múltiplos fornecedores. O gateway guarda o token
  (access + refresh) e chama os mesmos endpoints que a CLI oficial chamaria, com o mesmo
  `client_id`.

## Decisão

Adotar a Opção B. O gateway reproduz, em TypeScript, o fluxo OAuth com PKCE das CLIs oficiais:

- Codex: `client_id` do Codex CLI e o endpoint de token da OpenAI usados por
  `codex login`, reimplementados em `src/providers/codex-client.ts` (obtenção/armazenamento/
  refresh de token), nunca copiando o código Go de `CLIProxyAPI/internal/auth/codex/`.
- Claude: o mesmo para o endpoint de token da Anthropic e o `client_id` do Claude Code,
  reimplementado a partir das regras observadas em `CLIProxyAPI/internal/auth/claude/`.

O token (access + refresh) é armazenado em arquivo local no host do gateway, com as mesmas
garantias de permissão que hoje protegem `~/.codex/auth.json` e `~/.claude/.credentials.json`
(diretório `0700`, arquivo `0600`, nunca montado em container, nunca logado). O refresh
acontece sob demanda no cliente HTTP, de forma equivalente ao `DeepSeekClient`, mas com um passo
adicional de renovação de token antes da requisição quando o access token expirou.

As variáveis de configuração novas (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` no plano original da
Seção 3 da migração) são reinterpretadas neste ADR como caminho para o arquivo de token OAuth
gerenciado pelo próprio gateway (ou pelas credenciais já existentes em `~/.codex`/`~/.claude`),
não como chave de API convencional. `.env.example` e a documentação de configuração devem
deixar essa distinção explícita para não confundir o operador.

## Trade-offs e consequências

Ganha-se: nenhuma cobrança adicional por token, alinhado à restrição de negócio já registrada;
reuso do login que o operador já mantém para as CLIs oficiais; paridade de modelo de custo com a
arquitetura anterior.

Perde-se: acoplamento a um endpoint de autenticação e a um `client_id` que não são API pública
documentada oficialmente — são artefatos observados do comportamento das CLIs. Podem mudar sem
aviso, exatamente como as flags internas que motivaram a migração (ADR-016). Diferente da
Messages/Responses API (versionada e estável), o fluxo OAuth em si não tem o mesmo compromisso
de estabilidade. Mitigação: isolar toda a lógica de OAuth em um módulo próprio por provedor,
com teste de contrato e falha explícita (erro público sanitizado, nunca fallback silencioso)
quando o fluxo de autenticação for rejeitado.

Risco adicional a registrar no threat model (`docs/security/threat-model.md`): usar a
assinatura de um produto para autenticar um cliente não oficial pode conflitar com os termos de
uso do fornecedor, mesmo sendo tecnicamente equivalente ao que a CLI oficial faz. Esse risco é
aceito explicitamente pelo dono do projeto para uso pessoal/LAN, na mesma lógica de
"constraints" já registrada no contexto canônico (`sem novas API keys`), e deve permanecer
documentado como risco residual, não como ausência de risco.

O access/refresh token da assinatura é um ativo tão sensível quanto os diretórios de
autenticação hoje protegidos (`~/.codex`, `~/.claude`) — a Fase 2 da migração precisa das mesmas
garantias de permissão de arquivo e da mesma proibição de log de conteúdo (ADR-004) aplicadas
ao novo armazenamento de token.

## Adendo (27/07/2026) — assimetria de risco entre Codex e Claude

Na implementação da Fase 2, a extração de regras de protocolo do `CLIProxyAPI/` (código Go
usado só como referência de estudo, não copiado) revelou uma assimetria importante entre os
dois provedores que não estava clara na Seção 3 do `migracao.md`:

- **Codex**: a reprodução do OAuth é reprodução de protocolo pura. `src/providers/oauth/codex-oauth.ts`
  usa o mesmo `client_id`, endpoints e PKCE que o `codex login` usa, e o cliente HTTP
  (`src/providers/codex-client.ts`) envia apenas os headers `Originator`/`Chatgpt-Account-Id`
  observados no tráfego real do Codex CLI. Nenhuma engenharia de evasão foi necessária.
- **Claude**: o `CLIProxyAPI` implementa, num módulo chamado explicitamente
  `claude_executor_cloaking.go`, um mecanismo de *cloaking* — calcula um hash de fingerprint
  (`cch`) que o Claude Code oficial produz, injeta blocos de system prompt fabricados para
  imitar a estrutura interna exata do cliente oficial e usa um transporte TLS com fingerprint do
  Firefox — especificamente para que a requisição pareça indistinguível do Claude Code oficial
  aos olhos da Anthropic. Isso é engenharia ativa de evasão de detecção de cliente não-oficial,
  não reprodução de protocolo, e **não foi implementado** nesta migração.

Decisão confirmada com o dono do projeto: `src/providers/oauth/claude-oauth.ts` e
`src/providers/anthropic-client.ts` implementam o fluxo OAuth/PKCE e os headers documentados
(`Anthropic-Version`, `Anthropic-Beta: oauth-2025-04-20,claude-code-20250219`, `X-App: cli`) sem
nenhum mecanismo de cloaking, fingerprint ou impersonação de TLS. Risco aceito explicitamente:
a Anthropic pode detectar o gateway como cliente não-oficial e bloquear ou limitar as
requisições OAuth do alias `claude-cli-*` — isso deve ser validado na Fase 8 (smoke real) e
documentado como risco operacional conhecido em vez de ser mascarado por evasão de detecção.
Se o bloqueio se confirmar na prática, a alternativa é revisitar esta decisão (ex.: migrar o
adaptador Claude para API key convencional, Opção A original desta ADR, aplicada só a esse
provedor).
