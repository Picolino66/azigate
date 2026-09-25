# ADR-021 — Catálogo Claude da geração 5 e `tool_choice` forçado rebaixado

- Status: aceito
- Fase: F7 (evolução de catálogo)
- Data: 23/09/2026
- Relaciona-se com: ADR-010 (supersede a lista de aliases e o alvo de `claude-cli`), ADR-016, ADR-018

## Contexto

O seletor de modelos do Claude Code na assinatura do operador passou a oferecer Opus 5.5
(padrão), Sonnet 5, Fable 5.1, Haiku 4.5 e Opus 5. O catálogo do gateway ainda publicava
Fable 5, Opus 4.8/4.7/4.6 e Sonnet 4.6/4.5, com `claude-cli` apontando para Sonnet 4.6.

Pela referência oficial da Messages API:

- `claude-opus-5-5`, `claude-opus-5` e `claude-fable-5-1` aceitam effort `low`, `medium`, `high`,
  `xhigh` e `max` com thinking adaptativo. O default da API é `medium` no Opus 5.5 e `high`
  nos demais;
- Opus 5.5 e Fable 5.1 **rejeitam com 400** `tool_choice` `{type:"any"}` e `{type:"tool"}`.
  Um agente OpenAI-compatible que envia `tool_choice: "required"` ou uma função nomeada
  quebraria em toda requisição;
- nenhum dos modelos removidos está aposentado pela Anthropic. A remoção é uma escolha do
  operador para espelhar o seletor.

## Alternativas consideradas

1. **Só adicionar os modelos novos**, mantendo os antigos. Nenhum cliente quebra, mas o
   catálogo diverge do seletor da assinatura.
2. **Espelhar o seletor** (escolhida pelo operador). O catálogo fica igual ao que a
   assinatura oferece. Clientes configurados com aliases removidos passam a cair no
   roteamento normal e recebem erro do upstream ou `model_not_allowed`.

Para o `tool_choice` forçado:

1. **Recusar com 400 público.** É explícito, mas quebra clientes que enviam `required`.
2. **Rebaixar para `auto`** (escolhida). A requisição sempre funciona, mas a chamada de
   ferramenta deixa de ser garantida.

## Decisão

- Aliases Claude publicados: `claude-cli-opus-5.5` → `claude-opus-5-5`,
  `claude-cli-opus-5` → `claude-opus-5`, `claude-cli-fable-5.1` → `claude-fable-5-1`,
  `claude-cli-sonnet-5` → `claude-sonnet-5`, `claude-cli-haiku-4.5` → `claude-haiku-4-5`
  e `claude-cli` → `claude-opus-5-5`.
- Removidos: `claude-cli-fable-5`, `claude-cli-opus-4.8`, `claude-cli-opus-4.7`,
  `claude-cli-opus-4.6`, `claude-cli-sonnet-4.6` e `claude-cli-sonnet-4.5`.
- Default de effort: `medium` no Opus 5.5 (igual à API) e `high` no Opus 5, Fable 5.1 e
  Sonnet 5. Haiku 4.5 segue sem effort.
- O catálogo marca `forcedToolChoice: false` no Opus 5.5 e no Fable 5.1. Nesses modelos a
  tradução converte `required` e função nomeada em `{type:"auto"}`. `auto` e `none` passam
  inalterados, e os demais modelos mantêm `any`/`tool`.

## Trade-offs

- Rebaixar para `auto` troca uma falha visível por uma garantia mais fraca: o modelo pode
  responder em texto sem chamar a ferramenta. O agente cliente continua sendo o único
  executor e trata a resposta textual normalmente.
- Remover aliases quebra configurações de clientes (Qwen, Continue, `ALLOWED_MODELS`) que
  os usam. A migração exige atualizar essas configurações.

## Consequências

- `ALLOWED_MODELS` do operador precisa listar os novos IDs para publicá-los.
- Os gates reais (`gate:claude`) ainda não foram executados para os modelos novos. As
  tabelas de operação os marcam como pendentes.
- Uma troca futura de catálogo repete este ADR: atualizar a matriz, o suporte a
  `tool_choice` forçado e os gates.
