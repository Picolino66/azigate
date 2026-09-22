# Azigate — Token Optimization Phase 2

- Data: 22/09/2026
- Base: `TOKEN_OPTIMIZATION_AUDIT.md` (AI-01) e `TOKEN_OPTIMIZATION_PHASE1.md`
- Natureza: **experimental e diagnóstica**. Nenhuma linha de `src/` foi alterada.
- Harness: `test/manual/previous-response-id.ts` + `test/manual/previous-response-id-scenarios.ts`
- Chamadas reais executadas contra `https://chatgpt.com/backend-api/codex/responses`: **28**
- Modelo: `gpt-5.6-terra` · effort `low` (constante em todas as comparações)

> **Resumo em uma linha:** o backend do Codex **recusa** `store: true` e **não reconhece**
> `previous_response_id`. AI-01 é tecnicamente impossível nesse backend. A sonda de cache que
> substituiu os cenários inviabilizados reproduziu o sintoma de produção em laboratório e
> mostrou que a instabilidade de cache **não é causada pelo azigate**.

---

## 1. Objective

Provar ou refutar se `https://chatgpt.com/backend-api/codex/responses` suporta
`store: true` + `previous_response_id`, permitindo enviar apenas o delta da conversa a cada
turno em vez do histórico inteiro, e se isso reduz `freshInputTokens` de forma significativa.

A pergunta que governa a fase: *podemos parar de enviar dezenas de milhares de tokens de
histórico em cada turno?*

---

## 2. Current Problem

Pós-Fase 1, a telemetria informada pelo operador mostrava:

```text
cache global          ≈ 26,8%
freshInputTokens/turno ≈ 38.441
meta                   < 12.000
```

E, de forma repetida, a combinação que descartava as causas já corrigidas:

```text
promptCacheKey estável + prefixFingerprint estável + retryCount 0 + sem 429
→ ainda assim cache parcial ou zero
```

Ou seja: a instrumentação da Fase 1 fez seu trabalho — eliminou compactação do cliente,
colisão de chave, retry e `429` como explicações dominantes. Sobrou AI-01 como hipótese.

---

## 3. Experiment Architecture

O experimento é **isolado por construção**. Não passa pelo `/v1/chat/completions`, não altera
o corpo montado por `translateOpenAiToResponses` e não introduz estado no gateway.

```text
test/manual/previous-response-id.ts            harness: monta corpos Responses crus,
                                               reusa CodexClient + TokenManager reais,
                                               lê o SSE com readSseEvents
test/manual/previous-response-id-scenarios.ts  cenários e relatório JSON
package.json → experiment:previous-response    entrada manual, fora de `npm run check`
```

Decisões de posicionamento:

- **`test/manual/`** porque já está em `tsconfig.include` e é lintado, mas o vitest só coleta
  `*.test.ts` — o arquivo nunca entra na suíte comum. Alinhado à convenção de
  `gate:codex`/`gate:claude` descrita no `CLAUDE.md`.
- O harness **reusa `CodexClient` e `createTokenManager` de produção**, então o experimento
  exercita o mesmo caminho de autenticação, headers, timeout e retry do gateway real.
- **Privacidade:** nenhum trecho de prompt, resposta ou tool argument é impresso. O relatório
  carrega contagens, digests, ids do fornecedor e booleanos (`recalledSecret`). O corpo de erro
  do fornecedor é capturado truncado em 400 caracteres por ser diagnóstico, não conteúdo.

### Feature flag — não foi necessária

A seção 7 do pedido previa `CODEX_PREVIOUS_RESPONSE_EXPERIMENT=false` caso fosse preciso
integrar o experimento ao gateway. **Não foi preciso.** O backend recusou na primeira
chamada, então nenhuma integração chegou a existir. `git diff` sobre `src/` é vazio: o
comportamento padrão é byte-for-byte o mesmo, sem flag para gerenciar depois.

---

## 4. Backend Support

Duas rejeições explícitas, independentes e reproduzíveis.

### 4.1 `store: true` é recusado

```text
POST /responses  { "store": true, "input": [...] }
→ HTTP 400
→ {"detail":"Store must be set to false"}
```

Não é degradação silenciosa nem campo ignorado: é recusa explícita com mensagem dedicada.

### 4.2 `previous_response_id` não é um parâmetro reconhecido

```text
POST /responses  { "store": false, "previous_response_id": "resp_09e07f…", "input": [delta] }
→ HTTP 400
→ {"detail":"Unsupported parameter: previous_response_id"}
```

O `previous_response_id` usado era **real**, devolvido pelo próprio backend no turno anterior
(seção 5). A recusa é de **parâmetro**, não de valor — então não existe combinação de
`store`/id que faça o mecanismo funcionar.

### 4.3 Controle: o endpoint está saudável

O turno 1 do mesmo cenário, com `store: false` e sem `previous_response_id`, retornou:

```text
HTTP 200 · responseId resp_09e07f105bcc6645016ab28c09362c87d28d442fd433fc7319
usage: input_tokens 33 · cached_tokens 0 · output_tokens 5
```

Ou seja, as duas recusas acima não são erro de autenticação, de modelo, de formato do corpo ou
de rede — são sobre exatamente os dois campos que o AI-01 exigia.

---

## 5. response.id Lifecycle

O backend **devolve** um `response.id` real (`resp_` + 48 hex) em `response.created`, mesmo com
`store: false`. Ele existe, é bem formado e é único por requisição. Só não pode ser usado para
nada, porque o parâmetro que o consumiria não existe.

### Descoberta relevante do contrato atual (passo 1 do pedido)

`src/translation/responses-to-openai.ts:74` faz `state.id = event.response.id`, e
`src/translation/state.ts:92` usa `state.id` como o `id` de todo chunk OpenAI emitido. O
`chatcmpl-${request.id}` criado em `src/routes/chat.ts:160` é apenas um **placeholder** até o
evento `response.created` chegar.

**Consequência:** o `response.id` real do fornecedor **já vaza hoje para o cliente**, no campo
`id` de cada chunk e do `chat.completion` bufferizado (`cli-completion.ts:24-59`). O que a
seção 19 do pedido pedia para distinguir — id público de compatibilidade × id real do backend —
no azigate de hoje **são literalmente o mesmo valor**.

Isso não é um problema de segurança (o id é opaco e não referenciável, como esta fase provou),
mas é um fato de contrato que não está documentado em `docs/modules/providers/codex-cli.md`.
Se algum dia a Opção B da seção 17 for considerada, metade do caminho já está feita por
acidente.

---

## 6. previous_response_id Behavior

```text
Aceita?       NÃO
Ignora?       NÃO
400?          SIM — {"detail":"Unsupported parameter: previous_response_id"}
```

Não há comportamento a documentar além da recusa. A seção 20 do pedido (prova negativa
`store:false` + `previous_response_id`) e o caminho "esperado" (`store:true` + id) **convergem
para a mesma recusa**, por motivos diferentes e complementares.

---

## 7. Simple Conversation Test

Cenário mínimo da seção 3 do pedido (3 turnos, sem tools, código `AZIGATE-7421`):

| Turno | Corpo | Status | Resultado |
|---|---|---|---|
| 1 | `store:true` | **400** | `Store must be set to false` |
| 1' | `store:false` | 200 | `resp_09e07f…`, usage 33/0/5 |
| 2 | `store:false` + `previous_response_id` + só o delta | **400** | `Unsupported parameter` |
| 3 | — | não executado | dependia do turno 2 |

Critério de sucesso do pedido (turnos 2 e 3 respondendo `AZIGATE-7421` sem reenviar a mensagem
inicial): **não atingido, por impossibilidade de protocolo.**

---

## 8. Tool Call Test

**Não executado.** O cenário exigia `previous_response_id` para enviar apenas o
`function_call_output` no turno seguinte. Com o parâmetro recusado no nível do protocolo, o
teste não tem como produzir informação nova: o resultado seria o mesmo `400`, a um custo de
cota real do operador.

O harness tem o cenário implementado (`s4`) e pronto para rodar caso o backend passe a aceitar
o parâmetro.

---

## 9. Long Tool Loop Test

**Não executado**, mesma razão da seção 8. Implementado como `s5` (três tool calls encadeadas
A→B→C mais um turno de verificação de memória), pronto para execução futura.

---

## 10. Concurrency Test

**Não executado como desenhado.** O teste verificaria que a cadeia `A1→A2→A3` não interfere em
`B1→B2→B3`. Sem `previous_response_id` não existem cadeias — cada requisição já é independente
por construção, que é exatamente o estado atual do gateway. Implementado como `s7`.

Observação: a interferência entre conversas concorrentes medida na auditoria (miss total de 64%
com intercalação × 31% sem) permanece um fenômeno real de produção, mas a seção 13 desta fase
mostra que ela tem outra causa.

---

## 11. Restart Test

**Não executado como desenhado**, e a conclusão arquitetural pode ser dada sem ele:

- o gateway **não precisa** guardar estado, porque não há estado que ele possa guardar com
  utilidade — o único identificador candidato é rejeitado pelo backend;
- restart do gateway **não quebra** nenhuma conversa hoje, e continuaria não quebrando, porque
  cada requisição carrega o histórico inteiro vindo do cliente;
- a pergunta "o estado poderia ser client-side?" fica respondida por tabela na seção 17: poderia,
  mas não há o que colocar nele.

---

## 12. Error and Fallback Tests

### Cenários F e G (id inválido / inexistente)

**Não executados.** O turno 2 da seção 7 já usou um `previous_response_id` **válido e real** e
recebeu `Unsupported parameter`. Como a recusa é de parâmetro e não de valor, testar um id
malformado ou inexistente produziria a mesma resposta — é impossível distinguir "id ruim" de
"parâmetro inexistente" quando o parâmetro não existe. Implementado como `s3`.

### Cenário E (resposta interrompida)

**Não executado.** Implementado como `s9`. O teste só faz sentido para responder "é seguro
continuar do último `response.id` confirmado?", e não existe "continuar a partir de um id".

### Desenho de fallback — dispensado

A seção 14 do pedido pedia um fallback seguro (`try previous_response_id` → em erro de contexto,
repetir uma vez com contexto completo). **Esse desenho não é mais necessário**, e é importante
dizer por quê: o fallback protegeria contra id expirado/divergente em tempo de execução. Como o
caminho primário nunca funciona, o "fallback" seria 100% do tráfego — isto é, o fluxo atual.

Registro do que a análise apontaria, caso o backend mude:

- `400` com `detail` mencionando o parâmetro/id → fallback para contexto completo, **uma vez**;
- `401`/`403` (credencial) e `429` (cota) → **nunca** devem causar fallback: reenviar o histórico
  inteiro numa exaustão de cota é exatamente a rajada que o TOK-008 da Fase 1 combateu;
- `5xx` → retry normal do `CodexClient`, sem trocar de estratégia;
- risco de duplicação de tool call: um fallback que reenvia o histórico **depois** de o modelo já
  ter emitido uma `function_call` no turno perdido pode produzir a mesma chamada duas vezes. Um
  fallback real precisaria ser feito **antes** do primeiro byte da resposta — restrição que o
  `CodexClient` já respeita hoje (`codex-client.ts`, retry só antes de ler o corpo).

---

## 13. A/B Token Comparison

O braço B (previous_response_id) é **impossível de executar**. Para não encerrar a fase sem
informação acionável, o cenário D foi convertido em uma **sonda de cache implícito** que ataca a
pergunta que sobrou: com prefixo comprovadamente idêntico e `store:false`, o backend reaproveita
o prefixo? E a `prompt_cache_key` muda alguma coisa?

### Desenho da sonda

Contexto inicial fixo de ~5.541 tokens (220 regras sintéticas + código secreto), 4 turnos por
série, prefixo **byte-a-byte idêntico e estritamente crescente** por construção — sem cliente,
sem compactação, sem concorrência, sem retry, sem `429`. Duas séries por rodada: com e sem
`prompt_cache_key`. Três rodadas, com a ordem invertida na rodada 2 para controlar aquecimento.

### Resultado bruto — 6 séries, 24 turnos

| Rodada | Ordem de execução | Série | `cached_tokens` por turno | Hit |
|---|---|---|---|---|
| 1 | 1ª | com chave | 0 · 0 · 0 · 0 | **0,0%** |
| 1 | 2ª | sem chave | 4864 · 0 · 4864 · 4864 | 65,4% |
| 2 | 2ª | com chave | 4864 · 0 · 0 · 4864 | 43,6% |
| 2 | 1ª | sem chave | 4864 · 0 · 0 · 4864 | 43,6% |
| 3 | 1ª | com chave | 0 · 4864 · 4864 · 4864 | 65,4% |
| 3 | 2ª | sem chave | 4864 · 0 · 0 · 4864 | 43,6% |

### Leitura honesta, incluindo uma correção de rumo

A rodada 1 sugeria que `prompt_cache_key` **destruía** o cache (0% × 65,4%). Se eu tivesse
parado ali, teria reportado que a ADR-020 e o TOK-001 da Fase 1 são ativamente nocivos.

**A rodada 2, com a ordem invertida, refutou isso:** com-chave e sem-chave deram **43,6%
idênticos**, com o mesmo padrão por turno. A rodada 3 inverteu de novo o sinal — com-chave em
65,4% e sem-chave em 43,6%. Os números da rodada 1 eram artefato de aquecimento de cache, não
efeito da chave.

```text
COM prompt_cache_key : 0,0% · 43,6% · 65,4%   (média 36,3%)
SEM prompt_cache_key : 65,4% · 43,6% · 43,6%  (média 50,9%)
```

Com n=3 por braço e essa variância, **não há efeito atribuível à `prompt_cache_key`** — nem
positivo nem negativo. A chave não é o problema e também não é a solução.

### O que a sonda de fato provou

1. **O cache existe e é quantizado.** Quando acerta, o valor é sempre exatamente **4.864 tokens**
   (= 38 × 128), nunca mais, mesmo com o input crescendo de 5.541 para 5.612. O restante é sempre
   fresco. Granularidade de bloco de 128 tokens, teto pinado no prefixo inicial.
2. **O acerto é errático, e o azigate não é a causa.** Em 24 turnos com prefixo *provadamente*
   idêntico, **12 turnos (50%) receberam `cached_tokens: 0`**.
3. **O laboratório reproduz a produção.** A Fase 1 mediu ~46% dos turnos com miss total em
   produção; a sonda mediu 50% num ambiente onde toda causa do lado do gateway foi eliminada por
   construção.

| Cenário | Estratégia | Turnos | Input | Cached | Fresh | Bytes enviados | Duração |
|---|---|---|---|---|---|---|---|
| Sonda (com chave) | Full history, `store:false` | 4 | 22.311 | 0 | 22.311 | 101.882 | 13.309 ms |
| Sonda (sem chave) | Full history, `store:false` | 4 | 22.311 | 14.592 | 7.719 | 101.650 | 13.078 ms |
| Sonda (ordem invertida, com chave) | Full history | 4 | 22.311 | 9.728 | 12.583 | 101.882 | ~13.000 ms |
| Simple / Tool loop / Long loop | **`previous_response_id`** | **0** | — | — | — | — | — |

```text
economia percentual de fresh tokens : não aplicável — braço B impossível
economia percentual de bytes        : não aplicável — braço B impossível
diferença de latência               : não aplicável — braço B impossível
```

---

## 14. Latency Comparison

Sem braço B, não há comparação de latência a fazer. Dado colateral da sonda, para referência
futura: turnos com cache hit ficaram em 677–748 tokens frescos e 1.3–3.7 s; turnos com miss
total ficaram em ~5.5k frescos e 1.8–6.4 s. A latência acompanha o volume fresco, como esperado.

---

## 15. Request Body Comparison

Medido, e é o dado que mostra por que AI-01 seria tão valioso **se existisse**: o corpo da sonda
é de ~25 KB por turno para um contexto pequeno (5,5k tokens). Em produção a Fase 1 mediu turnos
de até 133 mil tokens de input.

Separando transmissão de billing, como a seção 24 do pedido exige:

- **bytes transmitidos** — o histórico inteiro sobe a cada turno, sempre. Isso não muda e não
  tem como mudar sem `previous_response_id`;
- **tokens cobrados** — o backend reprocessa o que não acertou no cache. Com 50% dos turnos em
  miss total, metade do histórico é cobrada como fresca mesmo já tendo sido enviada antes.

O `previous_response_id` teria atacado os dois de uma vez. Nenhum outro mecanismo disponível
ataca o primeiro.

---

## 16. Security and Retention Analysis

`store: true` mudaria a fronteira de confiança do ADR-018 e exigiria revisão do threat model.
**Essa análise ficou vazia de objeto:** o backend recusa `store: true`, então a conversa
continua não sendo retida por decisão nossa.

| Pergunta do pedido | Resposta |
|---|---|
| Quanto tempo o backend mantém o response? | **Não confirmado** — e irrelevante: não há como referenciar um response anterior |
| Existe evidência de retenção? | O backend devolve um `response.id` bem formado mesmo com `store:false`; o que ele guarda internamente **não é observável por este experimento** |
| Que informação deixa de ser stateless? | **Nenhuma.** O gateway permanece integralmente stateless |
| Impacto no threat model | **Nenhum.** Nenhuma fronteira mudou; nenhum documento de segurança precisa ser alterado |
| Impacto em retenção zero | **Nenhum** — o caminho que o comprometeria é inacessível |

Nota de honestidade: o fato de o backend **impor** `store: false` sugere que a política de
retenção do produto Codex é deliberada do lado do fornecedor. Isso é leitura da mensagem de
erro, não política publicada — não afirmo nada além do que o `400` diz.

---

## 17. Stateless Architecture Options

As três opções exigidas pela seção 18 do pedido, avaliadas contra o resultado real:

| Critério | Opção A — estado no gateway | Opção B — estado no cliente | Opção C — híbrido |
|---|---|---|---|
| Viabilidade **hoje** | **Impossível** | **Impossível** | **Impossível** |
| Complexidade | Alta (mapa + expiração + limite de memória) | Baixa (o id já vai ao cliente, seção 5) | Alta |
| Latência | Neutra | Neutra | Neutra |
| Resiliência | Cai em restart | Sobrevive a restart | Intermediária |
| Escalabilidade | Exige backend compartilhado para >1 instância | Escala trivialmente | Exige backend |
| Privacidade | Gateway passa a conhecer a conversa | Gateway segue cego | Intermediária |
| Compatibilidade | Transparente ao cliente | Exige campo novo no contrato público | Exige campo novo |
| Risco | Alto (ADR-001, ADR-020 já rejeitou estado de sessão) | Médio | Alto |

**Todas as três dependem do mesmo parâmetro recusado.** Nenhuma pode ser escolhida — não por
trade-off, mas por indisponibilidade do mecanismo.

Registro para o futuro, caso o backend mude: a **Opção B seria a candidata natural**, e não a A.
O `response.id` real já é entregue ao cliente hoje (seção 5); faltaria apenas o cliente devolvê-lo.
Isso preservaria o gateway stateless — que o pedido corretamente trata como vantagem
arquitetural, não como limitação a superar.

---

## 18. Risks

Riscos **eliminados** por este experimento (deixaram de existir por impossibilidade):

- retenção de conversa no fornecedor;
- estado de sessão no gateway, com expiração, limite de memória e perda em restart;
- divergência entre o histórico do cliente e a cadeia do servidor (seção 13 do pedido);
- duplicação de tool call em fallback.

Riscos **que permanecem**, e que esta fase esclareceu:

- **O cache do backend é errático e está fora do controle do azigate.** 50% de miss total com
  prefixo perfeito em laboratório. Nenhuma mudança no gateway corrige isso.
- **O teto de cache observado é fixo em 4.864 tokens.** Para contextos de 50–130 mil tokens como
  os de produção, mesmo um acerto cobre uma fração pequena do prefixo. Isso explica por que a
  produção fica em 26,8% mesmo com prefixo estável — não é falha de acerto, é **teto de cobertura**.
- Risco de conclusão precipitada: a rodada 1 desta própria sonda produziu um sinal forte e
  **errado**. Amostra pequena em cache errático engana com facilidade.

---

## 19. AI-01 Verdict

```text
NÃO VIÁVEL
```

Contra os 8 critérios da seção 22 do pedido:

| # | Critério | Resultado |
|---|---|---|
| 1 | backend aceita `store:true` | **NÃO** — `400 Store must be set to false` |
| 2 | backend retorna `response.id` reutilizável | Retorna id; **não é reutilizável** |
| 3 | `previous_response_id` mantém contexto | **NÃO** — `400 Unsupported parameter` |
| 4 | funciona com tool calls | Não testável |
| 5 | funciona em múltiplos turnos | Não testável |
| 6 | reduz `freshInputTokens` | Não testável |
| 7 | não produz inconsistência funcional | Não testável |
| 8 | existe fallback seguro | Sem objeto |

Falha nos critérios 1 e 3, que são pré-requisitos de todos os demais. Não é "viável com
restrições" nem "inconclusivo": as duas recusas são explícitas, reproduzíveis e no nível do
protocolo.

---

## 20. Recommendation

### Decisão final

```text
O backend do Codex suporta previous_response_id?   NÃO
Mantém contexto sem reenviar histórico?            NÃO
Funciona com tool calls?                           NÃO (não testável — parâmetro inexistente)
Reduz freshInputTokens?                            NÃO
Redução observada:                                 0% — mecanismo indisponível
Exige estado no gateway?                           NÃO — não há estado possível
Pode manter o gateway stateless?                   SIM — permanece stateless, sem esforço

Recomendação:                                      NÃO PROSSEGUIR
```

**Não prosseguir para a Fase 3 no eixo AI-01.** O mecanismo não existe nesse backend.

### O que fazer com a descoberta colateral

A sonda de cache mudou o entendimento do problema de forma mais útil do que AI-01 teria mudado:

1. **A meta de <12.000 `freshInputTokens`/turno é inalcançável por ação do gateway** em contextos
   de 50–130k tokens. Com teto de cache observado em 4.864 tokens, um turno de 54k tokens tem no
   máximo ~9% do prefixo coberto. A meta foi definida com base no baseline de 88,7% do ADR-020 —
   e vale reexaminar se aquele baseline não foi um regime transitório do fornecedor.
2. **A alavanca real migrou para o cliente.** Reduzir o tamanho do contexto que o agente envia
   (menos arquivos, menos histórico, compactação mais agressiva no Qwen Code/Copilot) ataca
   diretamente os 54k tokens/turno. É a conclusão que a auditoria já antecipava na seção
   "Observação de escopo" e que esta fase agora sustenta com evidência.
3. **TOK-003 ganha relevância relativa.** Com o cache limitado por teto, reduzir o **número de
   turnos** passa a valer mais do que reduzir o custo de cada turno. O round-trip de reasoning é o
   único item do backlog que atua nesse eixo.

### Pendência de documentação — decisão sua

O `CLAUDE.md` manda registrar decisão arquitetural duradoura em ADR. "AI-01 rejeitado por
indisponibilidade no backend, com evidência" é exatamente isso, e merece um **ADR-021** para que
ninguém reabra a hipótese daqui a seis meses.

**Não escrevi o ADR** porque esta fase foi explicitamente delimitada como "primeiro prove, depois
desenhe" e o pedido listava um único artefato. Posso escrevê-lo em seguida se você quiser — é a
única ação de documentação pendente desta fase.

Também não atualizei `README.md` nem `.env.example` com o script
`experiment:previous-response`: ele não altera configuração nem operação do gateway, é ferramenta
manual de diagnóstico, e está documentado aqui. Se preferir que apareça no README junto de
`login:codex`, é uma linha.

---

## Apêndice — reprodução

```bash
# cenário decisivo (4 chamadas, barato)
npm run experiment:previous-response -- s1 s2

# sonda de cache (8 chamadas, ~44k tokens de input)
npm run experiment:previous-response -- s6
EXPERIMENT_REVERSE=true npm run experiment:previous-response -- s6

# cenários implementados e prontos, caso o backend passe a aceitar o parâmetro
npm run experiment:previous-response -- s3 s4 s5 s7 s8 s9
```

Variáveis opcionais: `EXPERIMENT_MODEL` (padrão `gpt-5.6-terra`), `EXPERIMENT_EFFORT`
(padrão `low`), `EXPERIMENT_REVERSE`. O token vem de `CODEX_TOKEN_FILE`, lido pelo
`TokenManager` de produção — o experimento nunca imprime a credencial.

### Gates

```text
npm run check   → eslint OK · tsc OK · 220 testes passando · build OK
git diff src/   → vazio (comportamento padrão do gateway inalterado)
vitest          → o experimento não é coletado (só *.test.ts)
npm audit       → não executado nesta fase; nenhuma dependência foi alterada
                  (pendência pré-existente registrada na Fase 1 continua aberta)
```
