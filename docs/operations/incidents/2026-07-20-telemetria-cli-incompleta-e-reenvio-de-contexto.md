# 20/07/2026 — Telemetria CLI incompleta e reenvio de contexto

## Sintoma

Chamadas Claude feitas pelo Qwen mostravam `inputTokens: 2` no gateway, enquanto a
interface da conta indicava crescimento de uso muito maior. O fluxo também produzia
`400 invalid_cli_request` após algumas respostas com tools, levando o cliente a
repetir chamadas.

## Causa

- O parser Claude registrava apenas `input_tokens` e ignorava
  `cache_creation_input_tokens` e `cache_read_input_tokens`.
- Cada request iniciava um CLI efêmero e reenviava transcript, instruções e tools em
  um bloco variável, reduzindo cache hits em relação ao uso direto multi-turn.
- Tool calls históricas eram comparadas com a allowlist do turno atual. O histórico
  válido do Qwen podia, portanto, ser recusado antes de chegar ao CLI.

## Correção

O protocolo v6 separa usage Claude/Codex, registra parcelas de cache e introduz
sessões efêmeras em RAM. Codex usa App Server e Claude usa `stream-json`; após um
prefixo semântico exato, somente o delta é enviado. Tool calls históricas continuam
validadas estruturalmente, mas somente novas decisões precisam pertencer à allowlist
atual. Contextos acima de 256 KiB são bloqueados antes do provider.

## Interpretação correta

Para Claude:

```text
promptTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
```

Para Codex, `cached_input_tokens` já está dentro de `input_tokens`, e
`reasoning_output_tokens` já está dentro da saída. A porcentagem da interface do
plano não é uma conversão direta de tokens brutos; a interface do provider continua
sendo a fonte da cota efetiva.

## Prevenção

- manter `maxRetries: 0` nos aliases CLI do Qwen;
- usar `/clear` entre tarefas sem relação;
- comparar `freshInputTokens`, parcelas de cache e `sessionReused`, não somente a
  porcentagem do plano;
- repetir o benchmark manual após upgrades dos CLIs.
