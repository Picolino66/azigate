# ADR-011 — Effort do Qwen para provedores CLI

## Status

Aceita em 20/07/2026. Complementa os ADR-008, ADR-009 e ADR-010 e supersede apenas a proibição de effort para Codex no protocolo v4.

## Contexto

O Qwen Code mantém `model.reasoningEffort` em sua configuração, mas envia o valor ao endpoint OpenAI-compatible como `reasoning: { "effort": "..." }`. O gateway aceitava apenas `reasoning_effort` no nível superior para Claude e ignorava effort no Codex, fazendo o default aparecer nos logs mesmo depois de `/effort`.

## Alternativas consideradas

1. Exigir `extra_body.reasoning_effort`: funciona, mas fixa o valor e impede o comando dinâmico do Qwen.
2. Aceitar somente o formato aninhado: corrige o Qwen, mas quebra clientes existentes.
3. Aceitar ambos, com precedência explícita, normalizar no gateway e revalidar no broker.

## Decisão

- Aceitar `reasoning_effort` e `reasoning.effort` somente nos aliases CLI; o campo plano tem precedência.
- Aceitar a enum pública `low`, `medium`, `high`, `xhigh` e `max`; entrada malformada recebe `400 invalid_cli_request`.
- Tratar `reasoning: false`, ausência e objeto sem effort como solicitação do default do modelo.
- Manter a matriz Claude existente.
- Para todos os modelos Codex, usar default `medium`, permitir como valores efetivos `low`, `medium`, `high` e `xhigh`, e reduzir `max` para `xhigh`.
- Evoluir o protocolo privado para v5. O Codex recebe o valor efetivo por `-c model_reasoning_effort="..."`, reconstruído a partir da allowlist; o cliente não fornece argv.
- Preservar integralmente o body do upstream, inclusive `reasoning`, sem aplicar esta normalização à DeepSeek.

## Trade-offs

O broker e o gateway precisam ser implantados juntos. O comportamento `reasoning: false` não desativa reasoning no CLI; ele escolhe o default documentado. Em troca, `/effort` do Qwen funciona dinamicamente sem configuração estática ou ampliação de argv.

## Consequências

- Logs de Codex passam a registrar o effort efetivo; um pedido `max` aparece como `xhigh`.
- O startup do broker verifica se a versão instalada reconhece `model_reasoning_effort`.
- Gates do Codex devem informar modelo e effort, e upgrades do CLI invalidam essa evidência.
- Nenhum formato, log ou comportamento do upstream é alterado.
