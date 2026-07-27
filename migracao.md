# Migração: do broker CLI para adaptadores HTTP nativos

Documento de especificação para execução por agente. Descreve **o que** muda, **por que**
muda, **como** fazer e **em que ordem**, para que `codex-cli-*` e `claude-cli-*` deixem de
depender de subprocessos e passem a ser OpenAI-compatible de forma determinística.

Referência de estudo: o repositório `CLIProxyAPI/` presente neste workspace. Ele resolve o
mesmo problema por outro caminho e serve como fonte de detalhes de protocolo já validados
em produção. **Não copie código Go**: extraia as regras de mapeamento e reimplemente em
TypeScript seguindo as convenções deste repositório.

---

## 1. Resumo executivo

Hoje o gateway executa `codex exec` e `claude --print` dentro do Bubblewrap, serializa a
conversa inteira dentro de um prompt de texto e pede ao modelo que devolva um objeto
`{content, tool_calls}` validado por JSON Schema. **O tradutor OpenAI é o próprio modelo.**

Depois da migração, o gateway fala HTTP diretamente com a Messages API da Anthropic e com a
Responses API da OpenAI, e a conversão de formato passa a ser código puro. **O tradutor
OpenAI passa a ser uma função determinística.**

O que sai: broker, socket Unix, Bubblewrap, subprocessos, prompt canônico, envelope de
decisão, sessões em memória. Aproximadamente 4.000 linhas.
O que entra: uma camada de tradução testável e dois clientes HTTP, reaproveitando o padrão
que já existe em [src/upstream/](src/upstream/).

---

## 2. Por que migrar

O motivo não é estética de arquitetura. É a origem das falhas registradas em
[docs/operations/incidents/](docs/operations/incidents/).

**Toda semântica da OpenAI hoje é um pedido em linguagem natural.** Em
[src/broker/prompt.ts](src/broker/prompt.ts) o gateway escreve "Obedeça tool_choice e
parallel_tool_calls" e depois verifica se o modelo obedeceu em `validateCliDecision`. Quando
o modelo desobedece, a requisição morre com `invalid_cli_output`. No modelo alvo,
`tool_choice` vira um campo do corpo HTTP e quem garante o cumprimento é o backend do
fornecedor — não há nada que o modelo possa desobedecer.

**As CLIs são agentes, não endpoints.** O prompt atual gasta a maior parte do seu orçamento
convencendo um agente a não ser agente ("não leia arquivos", "sua sandbox é descartável",
"read-only nunca justifica recusa"). Isso é comportamento fora da distribuição desses
produtos e degrada a confiabilidade de forma irrecuperável.

**Não existe superfície suportada para injetar function tools nas CLIs.** Verificado nas
versões instaladas (codex-cli 0.144.6, Claude Code 2.1.215): `claude --tools` aceita apenas
o conjunto embutido, e `codex exec` aceita apenas um prompt de texto. O envelope de decisão
não foi uma escolha ruim — era a única expressão possível. O teto de confiabilidade vem
junto com ela.

**O acoplamento é a flags internas voláteis.** `--output-schema`, `--json-schema` e o
protocolo App Server mudam a cada release; foi assim que nasceu o incidente do `oneOf`
rejeitado. As APIs HTTP são versionadas (`anthropic-version: 2023-06-01`) e estáveis.

Ganhos diretos: streaming incremental real, tool calling nativo, multimodal, structured
outputs disponíveis para o cliente, prompt caching, e o desaparecimento de uma classe
inteira de erros (`invalid_cli_output`, `cli_execution_failed`, timeouts de processo).

---

## 3. Decisão que precede tudo: a credencial

Esta decisão muda o resto da migração e **precisa ser tomada pelo dono do projeto antes da
Fase 1**. A camada de tradução é idêntica nos dois casos; muda apenas de onde vem o token e
para qual host se conecta.

### Opção A — manter do jeito que está e melhorar

Melhorar o jeito que está para não ter erro mais.

### Opção B — credenciais OAuth da assinatura (recomendada)

É o que o `CLIProxyAPI` faz: reproduz o fluxo OAuth das próprias CLIs (o `client_id` do
Codex CLI e o endpoint de token da Anthropic estão em
[CLIProxyAPI/internal/auth/](CLIProxyAPI/internal/auth/)), guarda os tokens e chama
`chatgpt.com/backend-api/codex` e `api.anthropic.com` como se fosse a CLI oficial.

---

## 4. Arquitetura alvo

```text
Agente cliente -> HTTPS/Nginx -> Fastify
                              ├── src/upstream/        → upstream OpenAI-compatible (DeepSeek)
                              ├── src/providers/anthropic/ → api.anthropic.com  /v1/messages
                              └── src/providers/codex/     → api.openai.com     /v1/responses
```

Módulos novos:

| Caminho | Responsabilidade |
| --- | --- |
| `src/translation/openai-to-anthropic.ts` | ChatBody → corpo Messages API. Função pura. |
| `src/translation/anthropic-to-openai.ts` | Eventos SSE Anthropic → chunks OpenAI; resposta buferizada → `chat.completion`. |
| `src/translation/openai-to-responses.ts` | ChatBody → corpo Responses API. Função pura. |
| `src/translation/responses-to-openai.ts` | Eventos SSE Responses → chunks OpenAI. |
| `src/translation/state.ts` | Estado por stream (índices de tool call, id, model, created). |
| `src/providers/anthropic-client.ts` | Cliente Undici, headers, streaming, erros. |
| `src/providers/codex-client.ts` | Idem para a Responses API. |

Módulos removidos: `src/broker/` inteiro, `src/providers/broker-client.ts`,
`src/providers/openai-response.ts` (o regime sintético), `config/systemd/azigate-broker@.service`,
e os testes `test/broker*.test.ts`, `test/prompt.test.ts`, `test/execution-log.test.ts`.

Módulos preservados sem alteração de contrato: [src/security/](src/security/),
[src/http/](src/http/), [src/observability/](src/observability/), [src/models/](src/models/),
[src/upstream/](src/upstream/).

[src/cli-catalog.ts](src/cli-catalog.ts) permanece: os aliases `codex-cli-*` e `claude-cli-*`
continuam sendo o contrato público com o cliente. Só muda para onde eles roteiam. O mapa de
`effort` continua útil — vira `reasoning.effort` (Responses) e `thinking`/`output_config.effort`
(Anthropic) em vez de argumento de linha de comando.

---

## 5. Invariantes do CLAUDE.md que esta migração altera

O agente executor **precisa** registrar cada uma destas em ADR antes de implementar. Não
altere silenciosamente.

| Invariante atual | Situação após a migração |
| --- | --- |
| "O upstream usa apenas os paths tipados `models` e `chat/completions`" | Passa a haver três adaptadores com paths distintos. Reescrever a invariante como: cada adaptador tem paths tipados e fechados, nenhum aceita path do cliente. |
| "Preserve o regime sintético documentado: heartbeat, decisão validada atômica" | Substituído por streaming incremental real. O heartbeat deixa de existir; keep-alives passam a ser os do upstream. |
| "Subprocessos do broker usam `spawn` sem shell, argv fixo, Bubblewrap…" | Deixa de existir. Remover da lista. |
| "O protocolo do broker aceita somente request ID, provider, mensagens e ferramentas normalizadas" | Deixa de existir. Remover. |
| "A validação textual/function tool adicional vale somente para aliases CLI" | Deixa de existir: passthrough completo passa a valer para todos os provedores. |
| "O agente cliente é o único executor" | **Reforçada.** Não há mais subprocesso algum; a garantia passa a ser estrutural em vez de imposta por sandbox. |
| "A credencial Bearer do gateway nunca segue para o upstream" | **Mantida e estendida** aos dois novos adaptadores. Cada um reconstrói `Authorization` com o seu próprio segredo. |
| "Nunca registre prompts, mensagens, respostas, bodies…" | **Mantida.** Vale integralmente para a camada de tradução. Não replique o request logging do `CLIProxyAPI`, que grava headers e body completos. |

ADRs a criar, no mínimo: (1) substituição do broker por adaptadores HTTP; (2) fim do regime
sintético de SSE; (3) escolha da estratégia de credencial da Seção 3.

O threat model em [docs/security/](docs/security/) precisa ser reescrito: some a superfície
de subprocesso/sandbox/socket, e nasce a superfície de dois upstreams adicionais com segredos
próprios e uma camada de tradução que manipula conteúdo do usuário.

---

## 6. Especificação de tradução

Esta é a parte que determina se a migração entrega "funciona perfeitamente em OpenAI". Todas
as funções desta seção devem ser **puras, síncronas e sem I/O**, para serem testáveis por
tabela de casos.

### 6.1 OpenAI Chat Completions → Anthropic Messages

| Origem (OpenAI) | Destino (Anthropic) |
| --- | --- |
| `model` | `model` |
| `messages[role=system].content` | blocos em `system[]` (array de `{type:"text",text}`) |
| `content` string em user/assistant | `content: [{type:"text",text}]` |
| `content[].image_url.url` com `data:` | `{type:"image",source:{type:"base64",media_type,data}}` |
| `content[].image_url.url` com `http` | `{type:"image",source:{type:"url",url}}` |
| `content[].file.file_data` com `data:` | `{type:"document",source:{type:"base64",media_type,data}}` |
| `assistant.tool_calls[]` | blocos `{type:"tool_use",id,name,input}` no mesmo `content` |
| `role:"tool"` + `tool_call_id` | mensagem `role:"user"` com `{type:"tool_result",tool_use_id,content}` |
| `max_tokens` | `max_tokens` |
| `top_p` | `top_p` |
| `stop` (string ou array) | `stop_sequences` (sempre array) |
| `stream` | `stream` |
| `tools[].function` | `tools[]` como `{name,description,input_schema}` |
| `tool_choice:"auto"` | `{type:"auto"}` |
| `tool_choice:"required"` | `{type:"any"}` |
| `tool_choice:"none"` | omitir `tools` ou usar `{type:"none"}` |
| `tool_choice:{function:{name}}` | `{type:"tool",name}` |
| `reasoning_effort` | `thinking` (`{type:"adaptive"}` + `output_config.effort`) ou `{type:"enabled",budget_tokens}` conforme o modelo |

Regras obrigatórias:

- `max_tokens` é **obrigatório** na Messages API. Sem ele o upstream rejeita. Defina um
  default por modelo no catálogo e nunca envie o corpo sem o campo.
- `tool_calls[].function.arguments` é uma **string JSON** na OpenAI e um **objeto** em
  `tool_use.input`. Faça o parse; se falhar ou não for objeto, use `{}`.
- IDs de tool call precisam ser saneados para o formato aceito pela Anthropic. Se o cliente
  não enviar `id`, gere no formato `toolu_` + sufixo aleatório.
- `temperature` e `top_p` juntos são rejeitados por alguns modelos com thinking ativo.
- Se houver `system` mas nenhuma mensagem, injete um turno de usuário mínimo — a API recusa
  `messages` vazio.

### 6.2 Anthropic SSE → chunks OpenAI

| Evento Anthropic | Ação |
| --- | --- |
| `message_start` | capturar `message.id`, `message.model` e `usage.input_tokens`. Não emitir chunk. |
| `content_block_start` com `text` | emitir chunk com `delta.role:"assistant"` |
| `content_block_start` com `tool_use` | abrir novo índice de tool call; emitir `delta.tool_calls[{index,id,type:"function",function:{name,arguments:""}}]` |
| `content_block_delta` / `text_delta` | `delta.content` |
| `content_block_delta` / `input_json_delta` | `delta.tool_calls[{index,function:{arguments: partial_json}}]` |
| `content_block_delta` / `thinking_delta` | `delta.reasoning_content` |
| `content_block_stop` | fechar o índice corrente |
| `message_delta` | `stop_reason` → `finish_reason`; `usage.output_tokens` |
| `message_stop` | emitir `data: [DONE]` |
| `error` | encerrar o stream com evento de erro sanitizado |

Mapa de `stop_reason`: `end_turn`→`stop`, `max_tokens`→`length`, `tool_use`→`tool_calls`,
`stop_sequence`→`stop`, `refusal`→`content_filter`.

### 6.3 OpenAI Chat Completions → OpenAI Responses (Codex)

Referência verificada:
[CLIProxyAPI/internal/translator/codex/openai/chat-completions/codex_openai_request.go](CLIProxyAPI/internal/translator/codex/openai/chat-completions/codex_openai_request.go).

Campos fixos do corpo: `instructions: ""`, `store: false`, `stream`, `parallel_tool_calls`,
`reasoning.effort` (default `medium`), `reasoning.summary: "auto"`,
`include: ["reasoning.encrypted_content"]`.

| Origem | Destino em `input[]` |
| --- | --- |
| `role:"system"` | item `{type:"message",role:"developer"}` |
| `role:"user"` texto | `content:[{type:"input_text",text}]` |
| `role:"assistant"` texto | `content:[{type:"output_text",text}]` |
| `image_url` | `{type:"input_image",image_url}` |
| `file.file_data` | `{type:"input_file",file_data,filename}` |
| `input_audio` | `{type:"input_audio",data,format}` |
| `assistant.tool_calls[]` | itens **de topo** `{type:"function_call",call_id,name,arguments}` |
| `role:"tool"` | item de topo `{type:"function_call_output",call_id,output}` |
| `tools[].function` | `{type:"function",name,description,parameters,strict}` achatado |
| `response_format.json_schema` | `text.format` (`type`,`name`,`strict`,`schema`) |
| `tool_choice:{function:{name}}` | `{type:"function",name}` achatado |

Regras obrigatórias:

- **Não envie `temperature`, `top_p`, `max_output_tokens`.** A Responses via Codex rejeita.
- Mensagem de assistant que contém **apenas** `tool_calls` não deve virar item `message`;
  emita direto os `function_call`, ou a correlação de `call_id` quebra.
- Remova `parallel_tool_calls` quando não houver `tools` no corpo.
- Nomes de ferramenta acima de 64 caracteres precisam ser encurtados (preservando o prefixo
  `mcp__` e o último segmento) com **mapa reverso** aplicado na resposta, para devolver ao
  cliente o nome original. Ver `buildShortNameMap` na referência.

### 6.4 Responses SSE → chunks OpenAI

| Evento | Ação |
| --- | --- |
| `response.created` | capturar `id`, `model`, `created_at`. Não emitir chunk. |
| `response.output_text.delta` | `delta.content` |
| `response.reasoning_summary_text.delta` | `delta.reasoning_content` |
| `response.output_item.added` com `function_call` | incrementar índice; emitir `delta.tool_calls[{index,id:call_id,function:{name}}]` |
| `response.function_call_arguments.delta` | `delta.tool_calls[{index,function:{arguments}}]` |
| `response.function_call_arguments.done` | emitir argumentos completos **apenas** se nenhum delta chegou |
| `response.output_item.done` | fallback quando o item nunca foi anunciado |
| `response.completed` / `response.incomplete` | `finish_reason` + bloco `usage` |

`finish_reason`: `completed` com tool call → `tool_calls`; `completed` sem tool call →
`stop`; `incomplete` com `max_output_tokens` → `length`; `content_filter` → `content_filter`.

Mapa de `usage`: `input_tokens`→`prompt_tokens`, `output_tokens`→`completion_tokens`,
`total_tokens`→`total_tokens`, `input_tokens_details.cached_tokens`→
`prompt_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`→
`completion_tokens_details.reasoning_tokens`.

### 6.5 Armadilhas já conhecidas

Extraídas do código de referência; cada uma merece teste de regressão.

- O buffer do leitor de SSE precisa ser grande. A referência usa 50 MB por linha, porque
  eventos com imagem em base64 estouram qualquer default.
- Envie `Accept-Encoding: identity` nos requests de streaming. Stream comprimido quebra o
  leitor linha a linha.
- A Anthropic rejeita `allowed_domains`/`blocked_domains` como array vazio em ferramentas
  `web_search_*`. Remova a chave em vez de enviar `[]`.
- IDs de tool call duplicados no mesmo turno precisam de tratamento explícito, ou a
  correlação com `function_call_output` se perde.
- Preserve o passthrough opaco de campos desconhecidos, conforme a invariante já existente.

---

## 7. Plano de execução em fases

Cada fase termina com `npm run check` verde. Não avance com gate vermelho, não marque gate
aprovado sem evidência. Fases 1 a 3 são independentes entre si e podem ser paralelizadas;
da 4 em diante a ordem é obrigatória.

**Fase 0 — Decisão e ADRs.** Registrar a escolha da Seção 3 e os ADRs da Seção 5. Atualizar
[docs/orchestrator-context.json](docs/orchestrator-context.json). Nenhum código.

**Fase 1 — Camada de tradução, sem rede.** Implementar os quatro módulos de
`src/translation/` com testes de tabela. É a fase mais longa e a que define a qualidade do
resultado. Critério: cobertura da camada acima de 90%, incluindo todos os casos da Seção 6.5.

**Fase 2 — Clientes HTTP.** `anthropic-client.ts` e `codex-client.ts` sobre Undici, seguindo
o padrão de [src/upstream/client.ts](src/upstream/client.ts): paths tipados, `redirect:
'error'`, allowlist de headers, HTTPS obrigatório em produção, cancelamento do cliente
propagado. Testar contra mock local, nunca contra o upstream real.

**Fase 3 — Configuração.** Novas variáveis em `src/config.ts` e `.env.example`
(`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, e os
`*_FILE` correspondentes). Suporte a segredo em arquivo, como já existe para o upstream
atual. Marcar como deprecadas as variáveis `BROKER_*` e `CLI_*`.

**Fase 4 — Roteamento.** [src/routes/chat.ts](src/routes/chat.ts) passa a despachar os
aliases para os novos adaptadores. `resolveProvider` continua sendo o registry fechado.
Manter o comportamento de nunca fazer fallback automático entre provedores.

**Fase 5 — Streaming.** Substituir `streamCliCompletion` por repasse incremental real,
reaproveitando [src/upstream/response.ts](src/upstream/response.ts). Encerrar com
`data: [DONE]`. Erro antes do primeiro byte vira status HTTP; erro depois vira evento SSE
sanitizado sem `[DONE]`.

**Fase 6 — Remoção.** Apagar `src/broker/`, o cliente do broker, o regime sintético, a
unidade systemd, e os testes correspondentes. Só depois que a Fase 5 estiver verde.

**Fase 7 — Documentação.** Seção 9.

**Fase 8 — Validação real.** Smoke manual pelo cliente OpenAI-compatible real, com tools,
com streaming e com multi-turn. Registrar o resultado; não encerrar a migração sem ele.

---

## 8. Estratégia de testes

Nenhum teste automatizado pode chamar a Anthropic ou a OpenAI reais. Estenda
[test/mock-upstream.ts](test/mock-upstream.ts) com dois servidores locais: um que fala
Messages API e outro que fala Responses API, ambos capazes de emitir SSE evento a evento.

Cobertura mínima obrigatória, além do gate de 80%/70% já existente:

- Tabela de tradução de requisição para os dois provedores, um caso por linha da Seção 6.
- Reconstrução de stream: dada uma sequência gravada de eventos do upstream, o conjunto de
  chunks OpenAI emitidos deve ser exatamente o esperado, inclusive a ordem.
- Tool calling multi-turn: requisição com `tools` → resposta com `tool_calls` → requisição
  seguinte com `role:"tool"` → resposta final. É o fluxo que mais falha hoje.
- Cancelamento do cliente no meio do stream encerra a conexão upstream.
- Sanitização: nenhum teste deve conseguir observar prompt, body, header de autorização ou
  segredo em log.
- Regressão para cada armadilha da Seção 6.5.

Mantenha `test/gateway.integration.test.ts` como está: o caminho DeepSeek não muda e serve
de prova de que a migração não regrediu o que já funcionava.

---

## 9. Documentação a atualizar

Conforme o fluxo docs-first obrigatório deste repositório:

- [docs/index.md](docs/index.md) e [docs/architecture.md](docs/architecture.md): novo diagrama, fim do broker.
- `docs/modules/providers/`: reescrever `codex-cli.md` e `claude-cli.md`; remover
  `sessoes-cli-em-memoria.md`; criar a documentação da camada de tradução em
  `docs/modules/translation/` com `index.md` e um arquivo por conversão.
- `docs/operations/`: remover `broker.md` e `execution-clean.md`; atualizar
  `openai-compatible-agents.md` e `qwen-code.md`.
- `docs/operations/incidents/index.md`: marcar os incidentes de 22 e 23/07/2026 como
  resolvidos por mudança arquitetural, com link para o ADR.
- `specs/gateway-api.md` e `specs/openapi.yaml`: o contrato HTTP externo não muda, mas as
  capacidades por modelo mudam (multimodal, structured outputs, streaming incremental).
- `README.md` e `.env.example`: nova configuração e nova operação.
- `docs/security/`: threat model reescrito conforme a Seção 5.
- ADRs da Seção 5.

Validar todos os links internos alterados.

---

## 10. Critério de conclusão

A migração está concluída quando, e somente quando:

1. Um cliente OpenAI-compatible real completa um ciclo com tools, streaming e multi-turn
   contra `codex-cli-*` e `claude-cli-*` sem nenhum erro de formato.
2. `npm run check` e `npm run test:coverage` estão verdes, com cobertura acima dos mínimos.
3. `npm audit --omit=dev --audit-level=high` sem vulnerabilidades altas.
4. Não existe mais nenhuma referência a `src/broker`, Bubblewrap ou socket do broker no
   código, na configuração, no systemd ou na documentação.
5. Código, testes, contratos e documentação estão coerentes, e os ADRs da Seção 5 estão
   escritos com contexto, alternativas, decisão, trade-offs e consequências.
6. Nenhum segredo, prompt, body ou dado sensível é observável em log ou em resposta de erro.

