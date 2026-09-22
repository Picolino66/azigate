# Azigate — Otimização de tokens, Fase 1

- Data: 21/09/2026
- Base: `TOKEN_OPTIMIZATION_AUDIT.md`
- Escopo executado: TOK-002, TOK-004, TOK-001, TOK-008, TOK-006
- Fora de escopo por decisão explícita: AI-01 e todos os demais findings

Objetivo da fase: criar uma base mensurável e corrigir os problemas de caching de baixo
risco **antes** de qualquer mudança arquitetural. Nenhuma invariante foi alterada — o
gateway continua stateless, o passthrough continua opaco, nada de workspace, nada de
memória de conversa.

---

## Implemented

### TOK-002 — Instrumentação do prompt

**Arquivos alterados**

```text
src/translation/openai-to-responses.ts   (+ ResponsesRequestMetrics, buildPrefixFingerprint)
src/routes/chat.ts                       (grava as métricas na telemetria)
src/types.ts                             (campos novos em RequestTelemetry)
src/app.ts                               (emite os campos no log por requisição)
src/providers/codex-client.ts            (retryCount no CodexExchange)
```

**Comportamento anterior**

O log por requisição trazia apenas usage e metadados de roteamento. Nenhuma dimensão da
*forma* do prompt era medida: tamanho do corpo, quantidade de itens, quantidade e peso das
ferramentas, chave de cache e estabilidade do prefixo eram todos invisíveis. As três causas
candidatas de um miss de cache — colisão de chave, compactação pelo cliente, expiração —
produziam exatamente a mesma linha de log.

**Comportamento novo**

`translateOpenAiToResponses` passa a devolver um terceiro campo, `metrics`, com
`promptCacheKey`, `prefixFingerprint`, `inputItemCount`, `toolCount` e `toolSchemaBytes`.
A rota grava esses valores mais `requestBodyBytes` (bytes do corpo já serializado) e
`retryCount` (tentativas repetidas pelo cliente HTTP) na telemetria, e o hook `onResponse`
os emite no log.

`prefixFingerprint` é o campo que resolve o diagnóstico: digest SHA-256 de 16 hex sobre os
três primeiros itens do `input`. Se ele muda entre turnos consecutivos da mesma
`promptCacheKey`, o cliente reescreveu o começo da conversa; se é estável e mesmo assim há
miss, a causa é roteamento ou eviction.

Nenhum campo carrega conteúdo. Todos são contagens ou digests unidirecionais.

**Testes criados** (11 em `test/translation-openai-to-responses.test.ts`, 2 em
`test/codex-client.test.ts`, 2 em `test/cli-gateway.integration.test.ts`)

- contagem de itens, ferramentas e bytes de schema;
- `toolCount`/`toolSchemaBytes` zerados quando o cliente não declara ferramentas;
- `prefixFingerprint` estável quando só o fim da conversa cresce;
- `prefixFingerprint` muda quando o começo da conversa é reescrito;
- `prefixFingerprint` é digest de 16 hex e não revela conteúdo;
- `retryCount` reflete tentativas repetidas; é zero quando a primeira tentativa responde;
- integração: todos os campos presentes na linha de log, com o conteúdo do prompt ausente.

---

### TOK-004 — `freshInputTokens`

**Arquivos alterados**

```text
src/routes/chat.ts   (observeProviderUsage)
```

**Comportamento anterior**

Quatro pontos do código liam `telemetry.freshInputTokens` — a agregação em
`GatewayMetrics.observeTokens`, o contador `fresh_input_tokens_total` e a linha de log — e
nenhum o escrevia. Confirmação empírica: zero ocorrências do campo em 320 linhas de log
reais. O contador agregado era sempre 0.

**Comportamento novo**

```ts
freshInputTokens = Math.max(0, prompt_tokens - (cached_tokens ?? 0))
```

Calculado sempre que o provedor reporta `prompt_tokens`. O piso em zero protege contra
usage inconsistente do fornecedor. Quando `cached_tokens` não vem, o valor é o input
inteiro — que é a leitura correta, não um número inventado.

Efeito colateral desejado: `fresh_input_tokens_total` em `GatewayMetrics` passa a acumular
de verdade, sem nenhuma alteração em `metrics.ts`.

**Testes criados** (5 em `test/cli-gateway.integration.test.ts`)

- sem cache: `input 100 / cached 0` → `fresh 100`;
- cache parcial: `input 120 / cached 90` → `fresh 30`, `cacheHitPercent 75`;
- cache total: `input 80 / cached 80` → `fresh 0`, `cacheHitPercent 100`;
- sem `cached_tokens`: `input 42` → `fresh 42`, `cachedInputTokens` e `cacheHitPercent`
  ausentes;
- provedor inconsistente (`cached > input`): `fresh 0`, nunca negativo.

---

### TOK-001 — Âncora da `prompt_cache_key`

**Arquivos alterados**

```text
src/translation/openai-to-responses.ts   (conversationAnchor, firstCallId, firstUserText,
                                          buildPromptCacheKey)
adr/ADR-020-prompt-cache-key-derivada-da-conversa.md   (adendo)
```

**Comportamento anterior**

```text
âncora = primeiro texto de usuário não vazio
chave  = sha256(qtd_tools + nomes_tools + "\0" + âncora)
```

Duas conversas concorrentes que abrem com o mesmo texto — o caso normal de duas sessões do
mesmo agente no mesmo repositório — recebiam a **mesma** chave, eram roteadas para a mesma
máquina e despejavam o prefixo uma da outra. A auditoria mediu: 64% de miss total quando a
requisição anterior vinha de outra conversa intercalada, contra 31% quando era continuação.

**Comportamento novo**

```text
âncora = primeiro call_id do histórico          (tool_calls[].id ou tool_call_id)
         ou, se ainda não houver nenhum,
         primeiro texto de usuário não vazio
chave  = sha256(qtd_tools + nomes_tools + "\0" + tipo_da_âncora + "\0" + valor)
```

O `call_id` é gerado pelo fornecedor, devolvido pelo agente a cada turno, estável enquanto a
conversa existir e único entre conversas. O tipo da âncora entra no digest antes do valor,
então um `call_id` e um texto de usuário de mesmo valor nunca colidem.

O gateway continua sem estado: a âncora é lida do corpo que o cliente já envia.

**Trade-off aceito e documentado:** enquanto não há tool call a âncora é o texto; no primeiro
turno que traz uma, passa a ser o `call_id`. A chave muda **uma vez por conversa**, nessa
transição. É aceitável porque o primeiro turno é o que *cria* o prefixo cacheado, não o que
se beneficia dele; a partir do segundo turno, quando o histórico cresce e o cache passa a
valer, a chave é estável até o fim. O adendo do ADR-020 registra o raciocínio e a alternativa
descartada.

**Testes criados** (11 em `test/translation-openai-to-responses.test.ts`)

1. mesma conversa → mesma chave, mesmo crescendo de 4 para 8 mensagens;
2. conversas com o mesmo texto de abertura e `call_id` diferentes → chaves diferentes;
3. primeiro turno sem `call_id` → fallback para o texto, comportamento anterior preservado;
4. ordem e quantidade de ferramentas continuam no digest, inclusive com âncora de `call_id`;
5. a chave não contém o conteúdo nem o `call_id` em claro;
6. usa o **primeiro** `call_id`, não o mais recente;
7. aceita `call_id` vindo só de uma mensagem `tool`;
8. `call_id` e texto de mesmo valor não colidem;
9. system volátil não muda a chave (regressão do comportamento original);
10. chave omitida quando não há âncora nenhuma;
11. âncora lida de conteúdo multimodal em partes.

---

### TOK-008 — `Retry-After`

**Arquivos alterados**

```text
src/providers/http-retry.ts      (retryAfterSeconds — normalizador)
src/providers/http-errors.ts     (ProviderUpstreamError carrega o valor)
src/upstream/errors.ts           (GatewayError ganha retryAfterSeconds)
src/http/errors.ts               (emite o cabeçalho)
src/providers/cli-completion.ts  (captura o cabeçalho do fornecedor)
src/providers/codex-client.ts    (piso de backoff só para 429)
specs/gateway-api.md             (contrato do cabeçalho)
```

**Comportamento anterior**

No caminho upstream, `retry-after` já era repassado ao cliente. No caminho CLI, a resposta do
fornecedor era descartada e substituída por um erro sanitizado **sem nenhum cabeçalho de
backoff** — o agente cliente não tinha sinal para recuar e voltava imediatamente. Telemetria
real: 25 respostas `429` em duas rajadas, a cada 20–30 segundos, cada uma carregando 80k–130k
tokens de histórico.

O retry interno usava exponencial de base 100 ms para todos os status retryable, incluindo
`429` de exaustão de cota.

**Comportamento novo**

1. `cli-completion.ts` captura `retry-after` da resposta do fornecedor, normaliza para
   segundos inteiros e anexa ao `ProviderUpstreamError`. O handler de erros emite o cabeçalho.
2. A normalização passa por `parseRetryAfter`, que já existia: aceita número de segundos ou
   data HTTP e **descarta qualquer outra coisa**. O que sai para o cliente é sempre um dígito
   gerado pelo gateway, nunca o texto recebido — não há caminho para injeção de cabeçalho.
3. `429` sem `Retry-After` passa a ter piso de espera de 1 s, limitado por
   `RETRY_MAX_DELAY_MS`. Os demais status retryable mantêm exatamente o exponencial de antes.

**Decisão de escopo registrada:** a captura ficou no driver compartilhado
`cli-completion.ts`, então vale para Codex **e** Claude. Separar por provedor exigiria um
condicional artificial no caminho comum para produzir um comportamento pior no Claude. O
`docs/modules/providers/claude-cli.md` foi atualizado de acordo.

**Testes criados** (3 em `test/codex-client.test.ts`, 3 em `test/cli-gateway.integration.test.ts`)

- `Retry-After` do fornecedor respeitado no retry interno (espera ≥ 900 ms para `retry-after: 1`);
- sem retry quando o `Retry-After` excede o teto configurado;
- piso aplicado em `429` sem cabeçalho, e **não** aplicado em `503` (comprova que o
  comportamento dos outros status não mudou);
- `retry-after: 42` do Codex chega ao cliente como `42`;
- data HTTP normalizada para segundos inteiros;
- valor inválido (`'não-é-um-número'`) descartado, cabeçalho ausente.

---

### TOK-006 — Requisições sem usage

**Arquivos alterados**

```text
src/routes/chat.ts   (usageObserved inicializado antes da chamada, marcado no usage)
src/types.ts
src/app.ts
```

**Comportamento anterior**

`usage` só era observado quando `response.completed` chegava. Aborto do cliente, timeout,
erro de stream ou `429` produziam uma linha de log **sem nenhum campo de token**, e sem
qualquer outra dimensão que permitisse dimensionar o turno. Na sessão medida, 25 de 140
requisições Codex (17,9%) desapareciam assim.

**Comportamento novo**

`usageObserved` é gravado como `false` antes da chamada ao provedor, nos dois caminhos CLI, e
só vira `true` quando o `usage` chega. As métricas de forma do prompt são gravadas **antes**
do envio, então um turno que falhe continua no log com `requestBodyBytes`, `inputItemCount`,
`toolCount`, `toolSchemaBytes`, `promptCacheKey`, `prefixFingerprint` e `retryCount`.

Nenhum número de token é inventado: `inputTokens`, `outputTokens` e `freshInputTokens`
permanecem **ausentes** quando o provedor não os reportou.

**Testes criados** (1 em `test/cli-gateway.integration.test.ts`)

- `429` do Codex: `usageObserved: false`, campos de token ausentes, todas as métricas de
  forma do prompt presentes e `retryCount` registrado.

---

## Metrics

Métricas disponíveis na linha de log a partir desta fase, para comparar antes e depois de
qualquer otimização futura:

| Campo | Origem | Disponível quando |
|---|---|---|
| `inputTokens` | provedor | usage reportado |
| `cachedInputTokens` | provedor | usage com `cached_tokens` |
| `freshInputTokens` | **derivado no gateway** | usage reportado |
| `cacheHitPercent` | derivado | usage com `cached_tokens` |
| `promptCacheKey` | derivado do corpo | sempre, no Codex |
| `prefixFingerprint` | derivado do corpo | sempre, no Codex |
| `requestBodyBytes` | corpo serializado | sempre, no Codex |
| `inputItemCount` | corpo traduzido | sempre, no Codex |
| `toolCount` | corpo traduzido | sempre, no Codex |
| `toolSchemaBytes` | corpo traduzido | sempre, no Codex |
| `retryCount` | cliente HTTP | sempre, no Codex |
| `usageObserved` | driver de streaming | sempre, nos dois caminhos CLI |

### Métrica única de sucesso

**`freshInputTokens` por turno**, contra as duas linhas de base já registradas:

```text
baseline ADR-020 (01/09/2026) : ~10.010 fresco/turno   (cache 88,7%)
sessão medida    (21/09/2026) : ~34.697 fresco/turno   (cache 47,65%)
meta                          :  <12.000 fresco/turno
```

Secundária: proporção de turnos com miss total — 53/115 (46%) hoje, 6/104 (5,8%) no baseline.

### Como diagnosticar um miss a partir de agora

Agrupar as linhas de log por `promptCacheKey` e observar `prefixFingerprint` entre turnos
consecutivos do mesmo grupo:

- fingerprint **mudou** → o cliente reescreveu o começo da conversa (compactação). Nada a
  corrigir no gateway;
- fingerprint **estável** e `cachedInputTokens` baixo → roteamento ou eviction. Aí sim é
  problema de chave, e o próximo passo seria AI-01.

Essa pergunta não tinha resposta possível antes desta fase.

---

## Validation

Todos os gates rodados na árvore final.

### `npm run check` (gate obrigatório do repositório)

```text
> eslint .                          OK, sem violações
> tsc --noEmit                      OK, sem erros
> vitest run                        15 arquivos, 220 testes, 220 passando
> tsc -p tsconfig.build.json        build OK
```

Antes desta fase: 194 testes. Depois: **220** (+26).

| Arquivo | Antes | Depois |
|---|---|---|
| `test/translation-openai-to-responses.test.ts` | 29 | 40 (+11) |
| `test/codex-client.test.ts` | 5 | 10 (+5) |
| `test/cli-gateway.integration.test.ts` | 21 | 31 (+10) |

### `npm run test:coverage`

```text
Statements : 85,65% (mínimo 80%)   OK
Branches   : 79,76% (mínimo 70%)   OK
Functions  : 85,59% (mínimo 80%)   OK
Lines      : 88,65% (mínimo 80%)   OK
```

### `npm audit --omit=dev --audit-level=high` — **FALHA (exit 1)**

Reportado com precisão, sem maquiagem:

```text
fast-uri  3.0.0-3.1.5 || 4.0.0-4.1.2   high      (transitiva, via fastify/ajv)
undici    7.0.0-7.28.0                 high      (direta, fixada em 7.28.0)
fastify   <=5.12.0                     moderate  (direta, fixada em 5.10.0)

3 vulnerabilidades (1 moderate, 2 high)
```

**Este gate falha, e a falha não vem desta fase.** `git diff --stat` confirma que
`package.json` e `package-lock.json` não foram tocados; nenhuma dependência foi adicionada,
removida ou movida. São advisories publicados depois da auditoria de baseline do repositório
(`docs/security/output/node-audit.txt`, 14/07/2026, "found 0 vulnerabilities") contra versões
que o projeto fixa deliberadamente.

Corrigir exige `npm audit fix --force`, que o próprio npm avisa instalar versões "fora do
intervalo declarado" (`fastify@5.12.5`, `undici@7.29.1`). Isso contraria a convenção de
dependências fixadas do `CLAUDE.md`, exige revalidação do gate completo e é **mudança de
dependência, não de telemetria** — fora do escopo desta fase e da instrução explícita de não
implementar nada além dos cinco findings.

**Encaminhamento recomendado:** tratar como item próprio, com atualização do
`docs/security/output/node-audit.txt` e execução do `npm run check` após o bump. A decisão de
quando fazer isso é sua.

### Regressão de telemetria de cache

Além dos testes por finding, ficam no lugar como regressão permanente:

- o teste de integração que garante que o conteúdo do prompt nunca aparece no log, agora
  também afirmando que o **digest** aparece e que o conteúdo que o originou não;
- os quatro casos de `freshInputTokens` mais o caso de provedor inconsistente;
- o caso de `429` que prova que nenhum token é inventado quando não há usage.

---

## Pending

Explicitamente **não implementados** nesta fase, sem nenhuma alteração parcial:

| ID | Título | Por que ficou de fora |
|---|---|---|
| `TOK-003` | Round-trip de `reasoning.encrypted_content` | Exige decisão por ADR entre implementar o round-trip ou remover a flag; impacto em tokens é <0,1% do volume |
| `TOK-005` | Expor agregados de `GatewayMetrics` | Rota nova amplia a superfície HTTP fechada; exige ADR, specs, inventário de endpoints e threat model |
| `TOK-007` | Aliases com sufixo de esforço | Ganho em tokens desprezível (reasoning é 0,07% do volume); ganho é de latência |
| `TOK-009` | Guarda de conteúdo vazio no ramo `user` | Pode haver motivo legítimo para preservar o item; exige teste que confirme o comportamento com histórico só de tool results |
| `TOK-010` | Campos de cache do upstream e do Anthropic | Fora do caminho Codex; corrige observabilidade de outro provedor |
| `AI-01` | `store: true` + `previous_response_id` | **Excluído por instrução explícita.** Quebra o caráter stateless (ADR-001), altera fronteira de confiança e não tem prova de suporte pelo backend do Codex |
| `AI-02` | Telemetria como gate de regressão no `CLAUDE.md` | Mudança de processo, não de código |
| `AI-03` | Alerta por tamanho de corpo | Depende de linha de base que só agora passa a existir |

Nada além dos cinco findings da fase foi alterado. Uma única correção adjacente foi feita:
a linha de `specs/gateway-api.md` que declarava `codex_upstream_error` como sempre `502`,
quando o código preserva o status do provedor — a mesma linha onde o cabeçalho `retry-after`
precisava ser documentado, e uma inconsistência entre documentação e implementação que o
fluxo docs-first manda resolver no mesmo trabalho.

---

## Documentação atualizada

| Arquivo | O que mudou |
|---|---|
| `adr/ADR-020-...md` | Adendo: nova âncora, trade-off do primeiro turno, risco de compactação e **reversão** da cláusula que proibia registrar o digest em log |
| `docs/modules/observability/logs.md` | Duas tabelas novas (campos de token e métricas de forma do prompt) e as regras de `freshInputTokens`, `usageObserved` e `promptCacheKey` |
| `docs/modules/providers/codex-cli.md` | Âncora por `call_id`, `retry-after`, piso de backoff em `429`, `retryCount` e métricas do prompt |
| `docs/modules/providers/claude-cli.md` | `retry-after` no driver compartilhado e `usageObserved` |
| `specs/gateway-api.md` | Seção do cabeçalho `retry-after` e correção do status de `*_upstream_error` |

`docs/index.md` não precisou mudar: nenhum arquivo novo de documentação foi criado, e a
entrada do ADR-020 já existia.

### Atenção — cláusula de ADR revertida

A decisão original do ADR-020 dizia: *"O campo nunca é registrado em log."* Havia um teste de
integração aplicando exatamente isso (`expect(logs).not.toContain(prompt_cache_key)`).

Esta fase **reverte essa cláusula deliberadamente**, porque a instrumentação pedida em
TOK-002 exige o `promptCacheKey` na telemetria — sem ele não há como agrupar turnos por
conversa e o diagnóstico de cache continua impossível. O que passa a ser registrado é o
digest, opaco por construção e irreversível. O teste foi convertido: agora afirma que o
digest aparece **e** que o conteúdo que o originou não aparece. O adendo do ADR documenta a
reversão com justificativa.

Se você preferir manter a cláusula original, o caminho é registrar apenas o
`prefixFingerprint` e perder a capacidade de agrupar por conversa — diga e eu reverto essa
parte especificamente.
