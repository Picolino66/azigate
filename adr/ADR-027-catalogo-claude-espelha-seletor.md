# ADR-027 — Catálogo Claude espelha o seletor atual e `max_tokens` padrão de 64000

- Status: aceito
- Fase: F5 (evolução de catálogo)
- Data: 13/11/2026
- Relaciona-se com: ADR-021 (supersede a lista de aliases), ADR-016, ADR-019

## Contexto

O seletor de modelos do Claude Code na assinatura do operador passou a mostrar quatro modelos:
Opus 5.5 (padrão), Fable 5.1, Sonnet 5 e Haiku 4.5. O catálogo do ADR-021 ainda publicava
`claude-cli-opus-5`.

Uma revisão do adaptador contra a referência atual da Messages API também mostrou que o
`max_tokens` aplicado quando o cliente não envia o campo era 8192. No Opus 5.5 e no Fable 5.1
o thinking é sempre ligado, e os tokens de raciocínio contam dentro de `max_tokens`: em efforts
`high`, `xhigh` e `max`, o raciocínio pode esgotar o limite e a resposta termina cortada com
`finish_reason: length`.

A API também oferece Fable 5.2, Sonnet 5.5 e Haiku 5.5, que o seletor da assinatura não mostra.

## Alternativas consideradas

Para o catálogo:

1. **Manter o Opus 5.** Nenhum cliente quebra, mas o catálogo diverge do seletor.
2. **Espelhar o seletor** (escolhida pelo operador), como no ADR-021.
3. **Publicar também os modelos que só a API oferece.** Ficou de fora: não há garantia de que
   a assinatura OAuth os sirva.

Para `max_tokens`:

1. **Manter 8192.** Respostas longas com effort alto continuam sendo cortadas.
2. **Default por modelo.** É mais preciso, mas cria mais uma coluna no catálogo sem ganho prático.
3. **Default único de 64000** (escolhida). Cabe no limite de saída de todos os modelos do
   catálogo (Haiku 4.5 aceita até 64000; os demais, até 128000). Como a negociação com a
   Anthropic é sempre SSE (ADR-019), o limite alto não causa timeout HTTP.

## Decisão

- Aliases Claude publicados: `claude-cli-opus-5.5` → `claude-opus-5-5`,
  `claude-cli-fable-5.1` → `claude-fable-5-1`, `claude-cli-sonnet-5` → `claude-sonnet-5`,
  `claude-cli-haiku-4.5` → `claude-haiku-4-5` e `claude-cli` → `claude-opus-5-5`.
- Removido: `claude-cli-opus-5`. Por ter o prefixo reservado, ele passa a receber
  `400 invalid_model`, sem fallback para o upstream.
- `ANTHROPIC_DEFAULT_MAX_TOKENS` passa de 8192 para 64000. Um `max_tokens` enviado pelo
  cliente continua tendo precedência.
- O resto do ADR-021 continua valendo: matriz de effort, `forcedToolChoice: false` no Opus 5.5
  e no Fable 5.1, e o thinking adaptativo sem `budget_tokens` nem `disabled`.

## Trade-offs

- Clientes configurados com `claude-cli-opus-5` (Qwen, Continue, `ALLOWED_MODELS`) passam a
  receber `400 invalid_model` e precisam trocar de alias.
- Quando o cliente não envia `max_tokens`, uma resposta pode ficar mais longa e mais cara antes
  de parar. O effort continua sendo o controle principal de gasto.

## Consequências

- Uma troca futura do seletor repete este processo: atualizar o catálogo, os testes, a
  matriz de `tool_choice` forçado e as tabelas de operação.
- Os gates reais (`gate:claude`) do Opus 5.5 e do Fable 5.1 continuam pendentes.
