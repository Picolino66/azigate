# Arquitetura do azigate

## Contexto

Um agente cliente OpenAI-compatible (por exemplo Qwen Code, GitHub Copilot, Cline ou
Continue) usa uma API no formato OpenAI. O gateway escolhe um provedor pelo `model`,
mas nunca executa as ferramentas oferecidas pelo agente.

```text
Computador do agente cliente
  Agente OpenAI-compatible + VS Code + repositórios
  lê arquivos, confirma ações, executa comandos e aplica alterações
             │ HTTPS/rede
             ▼
Servidor (self-hosted, onde você quiser)
  Nginx -> container azigate
              ├── src/upstream/    -> HTTPS (upstream OpenAI-compatible,
              │                        DeepSeek por padrão)
              ├── src/providers/anthropic-client.ts -> HTTPS api.anthropic.com
              │                                        (Messages API)
              └── src/providers/codex-client.ts     -> HTTPS chatgpt.com/backend-api/codex
                                                        (Responses API)
             │
             ▼
  Chat Completion/texto/tool calls
             │
             ▼
  O agente executa somente no seu computador
```

Não existe mais broker, socket Unix, Bubblewrap nem subprocesso. Os aliases
`codex-cli-*`/`claude-cli-*` são adaptadores HTTP diretos: o gateway traduz o corpo
OpenAI-compatible para o formato nativo de cada fornecedor em código puro, chama a
API real por HTTPS e traduz a resposta de volta. Essa migração está registrada em
[ADR-016](../adr/ADR-016-substituicao-do-broker-por-adaptadores-http.md),
[ADR-017](../adr/ADR-017-fim-do-regime-sintetico-de-sse.md) e
[ADR-018](../adr/ADR-018-credencial-oauth-da-assinatura.md).

## Padrão e módulos

O gateway continua um monólito modular e **totalmente stateless**: nenhum módulo
mantém sessão, cache de conversa ou processo de longa duração entre requisições.

- `config`: configuração e secrets do processo;
- `security`: autenticação, allowlist e rate limit local;
- `providers/registry`: registry fechado dos aliases e roteamento sem fallback;
- `upstream`: adaptador de upstream (`DeepSeekClient`), único construtor de URLs HTTPS opacas;
- `providers/anthropic-client.ts` / `providers/codex-client.ts`: clientes HTTP
  Undici para a Messages API e a Responses API, com paths fixos, `redirect: 'error'`,
  retry limitado a status configurados e cancelamento propagado;
- `providers/oauth/`: fluxo OAuth/PKCE próprio para Codex e Claude (obtenção,
  armazenamento `0600` e renovação de token), sem reutilizar código das CLIs oficiais;
- `translation/`: quatro conversores puros, síncronos e sem I/O entre o formato
  OpenAI Chat Completions e os formatos nativos Anthropic/Responses, nos dois
  sentidos (requisição e stream de eventos);
- `providers/cli-completion.ts`: driver que consome o SSE nativo de cada provedor,
  traduz evento a evento e ou repassa como streaming incremental real ou acumula em
  um `chat.completion` único, conforme o cliente pediu `stream`;
- `models`: catálogo do upstream cacheado combinado com aliases saudáveis (saudável
  = habilitado e com token OAuth salvo em disco);
- `observability`: métricas, stdout e JSONL privado somente de metadados; cada alias
  conhecido recebe uma cor ANSI própria no campo `model`, e o `effort` registrado é
  o valor normalizado efetivamente usado.

Não há banco, fila, frontend, proxy genérico nem persistência de conversa. Rate
limit e caches continuam locais a uma instância.

O upstream é fixo e opaco para o cliente, mas configurável pelo operador em
`DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY` (nomes históricos). Por padrão a DeepSeek;
pode ser qualquer API OpenAI-compatible (OpenAI, OpenRouter, Together, Groq, Mistral,
ou local via Ollama/LM Studio/vLLM) que exponha `models` e `chat/completions`.

## Registry e disponibilidade

- Os aliases Codex e Claude definidos no catálogo central são reservados mesmo quando desabilitados; nunca caem no upstream.
- Os aliases Codex escolhem modelos internos fixos por allowlist; `codex-cli` permanece sinônimo de `gpt-5.4`. Effort público é normalizado em código puro (`src/providers/reasoning-effort.ts`) antes de virar `reasoning.effort` no corpo da Responses API.
- Os aliases Claude escolhem cinco modelos completos; `claude-cli` é sinônimo de `claude-opus-5-5` ([ADR-021](../adr/ADR-021-catalogo-claude-geracao-5.md)). Os prefixos `codex-cli`/`claude-cli` são reservados: alias desconhecido recebe `400 invalid_model` e nunca segue para o upstream. A `ALLOWED_MODELS` publica somente modelos aprovados nos gates reais.
- Qualquer outro ID permitido é encaminhado ao adaptador de upstream.
- Não existe fallback automático entre provedores.
- `/v1/models` combina o catálogo do upstream com aliases habilitados cujo arquivo de token OAuth existe em disco (`CODEX_TOKEN_FILE`/`CLAUDE_TOKEN_FILE`).
- Se o upstream falhar, os aliases locais continuam listados. Se nenhum provedor estiver utilizável, a resposta é `503`.
- `/ready` considera o upstream configurado quando `READY_CHECK_UPSTREAM=false`; com a checagem ativa, basta o upstream ou um alias CLI estar saudável.

## Camada de tradução

Ver [docs/modules/translation/](modules/translation/index.md) para a especificação
completa de cada conversor. Resumo:

| Módulo | Direção |
|---|---|
| `openai-to-anthropic.ts` | corpo OpenAI Chat Completions → corpo Messages API |
| `anthropic-to-openai.ts` | evento SSE Messages API → chunk(s) OpenAI |
| `openai-to-responses.ts` | corpo OpenAI Chat Completions → corpo Responses API |
| `responses-to-openai.ts` | evento SSE Responses API → chunk(s) OpenAI |

Todas as funções são puras, síncronas e sem I/O — testáveis por tabela de casos,
sem precisar de rede real. `src/translation/state.ts` guarda o estado por stream
(índices de tool call, id, model, created) que os dois tradutores de resposta
compartilham.

## Credencial OAuth da assinatura

Os adaptadores Codex e Claude não usam API key paga por token: reproduzem o fluxo
OAuth/PKCE das CLIs oficiais para autenticar com a **assinatura** do operador
(`npm run login:codex`/`npm run login:claude`), conforme
[ADR-018](../adr/ADR-018-credencial-oauth-da-assinatura.md). O token (access +
refresh) fica em arquivo local (`0700`/`0600`), renovado sob demanda pelo próprio
gateway. Para o Claude, deliberadamente **não** há reprodução de técnicas de
fingerprint/cloaking do cliente oficial — risco aceito e documentado no adendo do
ADR-018.

## Usage

- Claude: `promptTokens = input + cache_creation + cache_read`.
- Codex: `promptTokens = input`; `cached_input_tokens` é subconjunto e
  `freshInputTokens = input - cached`.
- Reasoning Codex é subconjunto da saída, nunca parcela adicional.
- `totalTokens` é volume lógico, não porcentagem da cota do plano.
- Detalhes de cache e reasoning ficam em `prompt_tokens_details`/
  `completion_tokens_details`; a resposta OpenAI conserva os três campos padrão
  mais esses detalhes quando o provedor os informa.

## Streaming

Os três adaptadores agora usam o mesmo regime: **streaming incremental real**.

- Upstream (passthrough): bytes SSE são copiados imediatamente, inclusive
  keep-alive, campos futuros, usage e `[DONE]`.
- Codex/Claude: cada evento SSE nativo do fornecedor (`content_block_delta`,
  `response.output_text.delta`, etc.) é traduzido e repassado assim que chega,
  sem heartbeat artificial e sem bufferizar a resposta inteira.

Em ambos os casos, erro antes do primeiro byte vira status HTTP; erro depois do
início do stream vira um evento `error` sanitizado e encerra sem `[DONE]`.

## Fronteiras de confiança

1. Agente cliente -> Nginx: tráfego não confiável, HTTPS, Bearer, IP/model allowlists e limites.
2. Nginx -> container: rede local ainda autenticada; somente quatro rotas públicas.
3. Container -> upstream/Anthropic/Codex: HTTPS, paths fixos e credencial
   reconstruída por adaptador (upstream: API key; Codex/Claude: token OAuth da
   assinatura, nunca a credencial Bearer do cliente).
4. Container -> arquivo de token OAuth: leitura/escrita local `0600`, nunca logado.

## Decisões

- [ADR-005](../adr/ADR-005-registro-multiprovedor-e-broker-local.md): registry multiprovedor (parte do broker substituída pelo ADR-016).
- [ADR-006](../adr/ADR-006-qwen-como-unico-executor.md): agente cliente como único executor.
- [ADR-007](../adr/ADR-007-streaming-dividido-por-provedor.md): streaming por tipo de provedor (substituído pelo ADR-017).
- [ADR-008](../adr/ADR-008-aliases-codex-com-modelo-fixo.md): seleção Codex por aliases fechados.
- [ADR-009](../adr/ADR-009-claude-cli-esforco-configuravel.md): Claude no modelo padrão com esforço fechado.
- [ADR-010](../adr/ADR-010-aliases-claude-com-modelo-fixo.md): aliases Claude com modelo e effort fixados.
- [ADR-011](../adr/ADR-011-effort-qwen-para-provedores-cli.md): formatos de effort do Qwen e normalização Codex/Claude.
- [ADR-016](../adr/ADR-016-substituicao-do-broker-por-adaptadores-http.md): substituição do broker por adaptadores HTTP.
- [ADR-017](../adr/ADR-017-fim-do-regime-sintetico-de-sse.md): fim do regime sintético de SSE.
- [ADR-018](../adr/ADR-018-credencial-oauth-da-assinatura.md): credencial OAuth da assinatura.

## Referências de integração

- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)
- [OpenAI Responses API](https://developers.openai.com/codex/app-server/)
- [Qwen Code model providers](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/)
