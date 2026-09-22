# ADR-020 — `prompt_cache_key` derivada da âncora da conversa

- Status: aceito
- Fase: F7 (otimização de custo)
- Data: 01/09/2026
- Relaciona-se com: ADR-016, ADR-019

## Contexto

A telemetria de tokens só passou a funcionar em streaming após a correção que acompanha o
ADR-019. A primeira sessão medida (104 requisições `codex-cli-terra`, 66 minutos) mostrou:

```
input total     : 9.178.037
  cacheado      : 8.136.960  (88,7%)
  fresco (pago) : 1.041.077  (11,3%)
output total    :    68.432
```

O cache implícito por prefixo da OpenAI já operava — a hipótese inicial de ausência total de
cache estava errada. O problema é a taxa de acerto irregular. Seis requisições com miss total
consumiram 209.804 tokens frescos, 20% de todo o input pago da sessão. Nos misses parciais o
prefixo cacheado ficava defasado enquanto o input crescia:

| # | input | cacheado | fresco |
|---|---|---|---|
| 4 | 60.055 | 37.376 | 22.679 |
| 5 | 83.970 | 37.376 | 46.594 |
| 6 | 96.173 | 83.456 | 12.717 |

Turnos saudáveis da mesma sessão gastavam de 1.017 a 1.941 tokens frescos. Projetando essa
faixa sobre os 104 turnos, o esperado seria da ordem de 300 mil tokens frescos contra o
1,04 milhão observado.

A Responses API expõe `prompt_cache_key` como dica de roteamento: requisições com a mesma chave
tendem a ser servidas pela máquina que já tem o prefixo quente. O Codex CLI oficial envia o
identificador da sessão nesse campo. O azigate é stateless e não tem sessão para enviar.

## Opções consideradas

- Manter o campo ausente e depender só do cache implícito: é o estado medido, com dois terços
  do input pago vindo de miss evitável.
- Introduzir estado de sessão no gateway (mapa de conversa para UUID): contraria o ADR-001 e o
  caráter stateless do serviço, exigiria expiração e limite de memória, e criaria estado
  compartilhado entre requisições que hoje não existe.
- Aceitar um identificador de sessão vindo do cliente: ampliaria a superfície pública com um
  campo controlado pelo chamador, contra a invariante de que o cliente não governa como o
  gateway fala com o fornecedor (ADR-002, ADR-019).
- Derivar a chave, por função pura, de uma âncora estável da própria conversa: opção escolhida.

## Decisão

`translateOpenAiToResponses` calcula `prompt_cache_key` como
`azigate-<sha256 truncado em 32 hex>` sobre a concatenação de: quantidade e nomes das
ferramentas declaradas, um separador nulo, e a **âncora da conversa** — o texto da primeira
mensagem `user` não vazia.

Mensagens `system` ficam deliberadamente fora da âncora. Agentes clientes costumam injetar
conteúdo volátil nelas (data corrente, cwd, arquivos abertos); incluí-las rotacionaria a chave
a cada turno e anularia exatamente o roteamento que a decisão busca.

Quando não há mensagem `user` com texto, o campo é omitido em vez de receber um valor
degenerado — assim requisições sem âncora não são todas agrupadas sob uma única chave.

O campo nunca é registrado em log, e o digest é a única coisa derivada do conteúdo que sai do
processo.

## Trade-offs e consequências

Ganha-se estabilidade de roteamento ao longo de uma conversa, que é o pré-requisito para o
cache de prefixo ser aproveitado de forma consistente entre turnos.

A chave é uma dica de roteamento, não um controle de correção: o conteúdo efetivamente
reaproveitado continua sendo determinado pelo prefixo real da requisição. Uma colisão de âncora
entre conversas distintas não produz resposta errada — no máximo roteia duas conversas para a
mesma máquina.

Conversas cuja primeira mensagem de usuário seja idêntica (por exemplo um agente que sempre
inicia com o mesmo texto padrão) compartilharão a chave. O efeito é de roteamento, e o
conjunto de ferramentas entra no digest justamente para separar configurações diferentes de
agente.

Em um cenário multi-chamador — várias `GATEWAY_API_KEYS` sobre a mesma credencial OAuth do
fornecedor — dois chamadores com âncora e ferramentas idênticas passam a compartilhar a chave
de roteamento. Isso não expõe conteúdo entre eles: o cache do fornecedor é escopado à conta, e
essa conta já é única e compartilhada por construção (ADR-018). Registrado no threat model.

O `prompt_cache_key` é um campo aceito pela Responses API; se o backend passar a rejeitá-lo, a
falha aparece como `400`/`codex_upstream_error` já na primeira requisição, de forma
imediatamente observável, e a reversão é a remoção do campo.

---

## Adendo — 21/09/2026 — âncora por `call_id` e registro do digest

- Status: aceito
- Motivação: `TOKEN_OPTIMIZATION_AUDIT.md` (findings TOK-001 e TOK-002)

### O que a medição mostrou

A sessão de 21/09/2026 (140 requisições `codex-cli-terra`, já com esta ADR em produção)
registrou 47,65% de acerto de cache contra os 88,7% da sessão baseline acima. O fresco por
turno subiu de ~10.010 para ~34.697, e 53 turnos com miss total consumiram 2.503.648 tokens
frescos — 62,7% de todo o input pago da sessão.

A diferença entre as duas sessões é **concorrência**: 28 dos 114 pares consecutivos de
requisição se sobrepõem no tempo, ou seja, havia mais de uma conversa ativa sobre a mesma
credencial. Separando os pares:

| Requisição anterior | n | Miss total | Fresco/turno |
|---|---|---|---|
| Continuação plausível da mesma conversa | 61 | 19 (31%) | 38.373 |
| Outra conversa intercalada | 53 | 34 (64%) | 30.566 |

O miss total dobra quando há intercalação. É exatamente a consequência que a decisão
original registrou como aceita: "Conversas cuja primeira mensagem de usuário seja idêntica
compartilharão a chave." Duas sessões do mesmo agente, no mesmo repositório, abrem com o
mesmo texto, recebem a mesma chave, são roteadas para a mesma máquina e despejam o prefixo
uma da outra.

A correlação é evidência de interferência entre conversas concorrentes, não prova isolada de
colisão de chave — daí o segundo item deste adendo.

### Mudança 1 — a âncora passa a ser o primeiro `call_id`

`conversationAnchor` retorna agora uma âncora tipada:

1. **`call_id`** — o primeiro identificador de tool call encontrado no histórico, seja em
   `tool_calls[].id` de uma mensagem `assistant`, seja em `tool_call_id` de uma mensagem
   `tool`. É gerado pelo fornecedor, devolvido pelo agente a cada turno, estável enquanto a
   conversa existir e único entre conversas.
2. **`user_text`** — o comportamento anterior, usado apenas enquanto não existe nenhuma tool
   call no histórico.

O tipo da âncora entra no digest antes do valor, então um `call_id` e um texto de usuário de
mesmo valor nunca produzem a mesma chave.

Mensagens `system` continuam fora da âncora, pelo motivo original: conteúdo volátil injetado
pelos agentes rotacionaria a chave a cada turno.

### Trade-off aceito: a chave muda entre o primeiro e o segundo turno

Enquanto não há tool call, a âncora é o texto; no primeiro turno que traz uma, ela passa a ser
o `call_id`. A chave muda uma vez por conversa, nessa transição.

Isso é aceitável porque o primeiro turno é o menor da conversa — é o turno que **cria** o
prefixo cacheado, não o que se beneficia dele. A partir do segundo turno, quando o histórico
cresce e o cache passa a valer, a chave é estável até o fim.

A alternativa de omitir a chave no primeiro turno foi considerada e descartada: perderia o
roteamento de conversas que não usam ferramentas, que continuam funcionando pelo texto.

### Risco residual: compactação de histórico

Se o agente cliente compactar a conversa e descartar a primeira tool call, a âncora muda e a
chave rotaciona. O efeito é o mesmo da âncora anterior quando o primeiro texto de usuário é
descartado — e, nesse cenário, o prefixo real também mudou por inteiro, então o miss
aconteceria de qualquer forma. A âncora por `call_id` não piora esse caso.

### Mudança 2 — o digest passa a ser registrado em log

A decisão original determinava que "o campo nunca é registrado em log". **Este adendo reverte
essa cláusula.**

Motivo: sem o `promptCacheKey` na telemetria não há como agrupar turnos por conversa, e sem
esse agrupamento é impossível distinguir as causas candidatas de um miss — colisão de chave,
compactação pelo cliente ou expiração. A auditoria precisou inferir as conversas pelo
crescimento do `inputTokens`, uma heurística frágil que não sustenta decisão.

O que passa a ser registrado é o **digest**, já opaco por construção: `azigate-` seguido de 32
caracteres hexadecimais de um SHA-256 truncado. Não é reversível e não carrega trecho de
conversa. Junto dele passa a ser registrado o `prefixFingerprint`, digest de 16 hex dos três
primeiros itens do `input`, que existe para responder à pergunta que o `promptCacheKey`
sozinho não responde: se o prefixo enviado mudou entre dois turnos da mesma chave.

A invariante de não registrar prompts, mensagens, bodies, tool arguments ou secrets permanece
intacta — o teste de integração que garante isso continua no lugar, agora afirmando que o
digest aparece **e** que o conteúdo que o originou não aparece.

### Consequências

- `buildPromptCacheKey` passa a receber `ConversationAnchor` em vez de `string`. Continua
  função pura, síncrona e sem I/O.
- O gateway continua stateless: nada é memorizado entre requisições; a âncora é lida do corpo
  que o cliente já envia.
- A métrica de sucesso da mudança é `freshInputTokens` por turno, comparada com as duas linhas
  de base registradas acima.
