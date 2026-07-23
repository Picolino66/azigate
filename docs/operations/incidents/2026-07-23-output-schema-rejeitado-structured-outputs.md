# Incidente: outputSchema do broker rejeitado pelo structured outputs

## Resumo

Em 23/07/2026, depois de restabelecer o socket, toda requisição do Qwen para
`codex-cli-terra` com tools falhou com `502 cli_execution_failed` e reason
`codex_turn_error_event` cerca de dois segundos após `provider_turn_started`.
Severidade operacional: P2. Este era o defeito de fundo por trás do incidente
do retry registrado no mesmo dia.

## Evidência sanitizada

- O JSONL não registrava nenhuma execução `memory` bem-sucedida do broker.
- Probes mínimos fora do gateway funcionaram no host e dentro de um sandbox
  Bubblewrap equivalente ao do broker, inclusive com transcript de 158 KiB —
  desde que o `outputSchema` fosse um objeto simples.
- A reprodução manual do protocolo App Server com o schema real do broker
  retornou `invalid_json_schema` com a mensagem `'oneOf' is not permitted`,
  status 400 e `willRetry: false` — erro terminal, tratado corretamente pelo
  broker como `codex_turn_error_event`.
- Testes adicionais mostraram que a raiz precisa ser `type: "object"` (um
  `anyOf` puro na raiz também é recusado) e que todo schema de array precisa de
  `items` (o ramo de texto usava `maxItems: 0` sem `items`).

## Causa raiz

`decisionJsonSchema` gerava `{ oneOf: [ramo-texto, ramo-tools] }` sempre que o
request tinha tools com `tool_choice` auto — o caso de toda requisição do Qwen.
O validador de structured outputs da OpenAI rejeita `oneOf` na raiz, o backend
devolvia 400 e o App Server sinalizava erro terminal. Requisições sem tools
geravam um único objeto e passavam, o que explicava gates e smokes anteriores
aprovados.

## Correção

- O schema por request virou um único objeto plano: `content` aceita
  `string|null` conforme o `tool_choice`, `tool_calls` mantém `items` sempre
  presente, `enum` dos nomes oferecidos, `minItems` quando tools são
  obrigatórias e `maxItems` conforme `parallel_tool_calls`.
- O XOR texto/tools e as demais regras continuam garantidos por
  `validateCliDecision` no broker e no gateway, como já documentado em ADR-015.
- O broker passou a classificar o `codexErrorInfo` da notificação terminal em
  um enum fechado (`errorCode` no JSONL e sufixo no nome do erro do journal),
  sem nunca registrar a mensagem do provedor.

## Verificação

- 185 testes com `npm run check` verde, incluindo regressões que proíbem
  `oneOf`/`anyOf` na raiz e arrays sem `items` em todas as variantes.
- As três variantes do schema novo foram aceitas pela API real em probes
  manuais mínimos, incluindo uma decisão de tool call estruturalmente válida.
- Permanece obrigatório um smoke real pelo Qwen com tools após o deploy,
  acompanhando somente o JSONL privado.
