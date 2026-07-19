# ADR-010 — Aliases Claude com modelo e effort fixados

## Status

Aceita em 18/07/2026. Supersede parcialmente o ADR-009 quanto ao alias único, modelo padrão da conta e tratamento de effort incompatível.

## Contexto

O alias único `claude-cli` não permitia ao Qwen selecionar de forma determinística uma versão Claude. O Claude Code `2.1.214` reconhece modelos completos por `--model`, mas o cliente não pode controlar argv livremente. Cada modelo também possui uma matriz própria de effort.

## Alternativas consideradas

1. Continuar no modelo padrão da conta: simples, mas não determinístico.
2. Aceitar um nome de modelo arbitrário no payload: flexível, porém amplia a fronteira de confiança.
3. Criar aliases públicos fechados com modelo, efforts e default definidos em catálogo central.

## Decisão

- Publicar oito aliases versionados e manter `claude-cli` como sinônimo de `claude-cli-sonnet-4.6`.
- Traduzir cada alias para um único nome completo aceito pelo Claude Code.
- Aplicar o effort padrão do catálogo quando omitido ou incompatível; valor fora da enum global continua inválido.
- Sonnet 4.5 e Haiku 4.5 nunca recebem `--effort`.
- Evoluir o protocolo privado para v4, com `model` obrigatório para Codex e Claude e validação independente no broker.
- Acrescentar `--model` e, quando aplicável, `--effort` ao argv fixo. Nenhum argumento arbitrário é aceito.
- Certificar cada modelo com gate real completo e publicar somente os aprovados por meio de `ALLOWED_MODELS`.

## Trade-offs

O catálogo precisa evoluir quando surgirem modelos ou mudarem capacidades. Os gates reais consomem cota por modelo. Em troca, seleção, custo e effort ficam explícitos, auditáveis e sem ampliar a capacidade do cliente sobre o subprocesso.

## Consequências

- Gateway e broker v4 devem ser implantados juntos.
- Alias reprovado no gate permanece reservado, mas fica fora da allowlist e do catálogo publicado.
- Falha de um modelo não bloqueia outros modelos Claude aprovados.
- DeepSeek e Codex preservam seus contratos e não existe fallback automático.

## Evidência inicial de publicação

O gate real no Claude Code `2.1.214`, executado em 18/07/2026, aprovou Fable 5, Sonnet 5, Opus 4.8, Opus 4.6 e Sonnet 4.5. Opus 4.7, Sonnet 4.6 e Haiku 4.5 reprovaram; por compartilhar Sonnet 4.6, o alias `claude-cli` também não foi publicado. Essa evidência é operacional e deve ser refeita após upgrade do CLI ou mudança do catálogo.
