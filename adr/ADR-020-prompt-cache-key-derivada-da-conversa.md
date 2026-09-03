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
