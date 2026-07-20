# ADR-013 — Check de capacidade Codex por catálogo estruturado

## Status

Aceita em 20/07/2026. Complementa os ADR-008 e ADR-011 sem alterar o protocolo
privado v5.

## Contexto

O startup check do broker provava `model_reasoning_effort` executando
`codex -c model_reasoning_effort="low" debug models` e exigindo que um valor
sentinela inválido encerrasse com erro. No upgrade automático de Codex CLI
`0.133.0` para `0.144.6`, `debug models` passou a encerrar com código zero também
para o sentinela. O check então marcaria Codex indisponível após o próximo restart,
embora `codex exec` e os modelos GPT-5.6 funcionassem.

## Alternativas consideradas

1. Remover a verificação de effort: compatível, mas deixaria de falhar fechado.
2. Fazer uma inferência no startup: prova o caminho completo, mas consome cota,
   depende da rede e pode produzir falso negativo por rate limit.
3. Ler o catálogo JSON embutido e validar modelos e efforts exigidos, mantendo
   `--ignore-user-config --strict-config` somente na inferência real.

## Decisão

- Executar `debug models --bundled` com o valor válido `low`, sem inferência.
- Interpretar o JSON estruturalmente, sem registrar seu conteúdo.
- Exigir os cinco modelos Codex fixados e todos os efforts efetivos usados pelo
  gateway (`low`, `medium`, `high`, `xhigh`).
- Falhar com `required_effort_config_missing` se o comando falhar, o JSON for
  inválido ou catálogo/modelo/effort estiver ausente.
- Manter a execução real com configuração ignorada, strict config, ferramentas
  desabilitadas e argv fechado.

## Trade-offs

O catálogo embutido prova suporte do binário, não entitlement remoto nem cota da
conta. Esses continuam cobertos pelo gate real por modelo. Em troca, o health não
faz chamadas pagas nem depende de disponibilidade externa no startup.

## Consequências

- Codex CLI `0.144.6` pode reiniciar sem falso negativo no check de capacidade.
- Upgrades continuam exigindo `npm run check` e smokes reais por modelo.
- O protocolo v5 e o gateway não mudam; somente broker, testes e operação precisam
  de novo `dist`.
