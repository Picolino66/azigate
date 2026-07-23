# Incidente: broker interrompe retry do App Server Codex

## Resumo

Em 23/07/2026, requisições do Qwen para `codex-cli-terra` falharam com
`cli_execution_failed` logo após o início do turno. Severidade operacional: P2.

## Evidência sanitizada

- O broker criou o workspace e iniciou o turno, mas não registrou
  `provider_turn_finished` nem `decision_validated`.
- Cada tentativa falhou em aproximadamente dois segundos, abaixo do timeout e
  com transcript abaixo do limite configurado.
- O JSONL registrou `codex_turn_error_event` para cada requisição.
- O schema TypeScript gerado pelo próprio `codex app-server generate-ts` na
  versão instalada define a notificação `error` com `willRetry`, `threadId` e
  `turnId`.

## Causa raiz

O broker tratava qualquer notificação `error` do App Server como terminal e
fechava a sessão. Isso cancelava a recuperação interna quando o evento trazia
`willRetry: true`.

## Correção

- O broker confere `threadId`, `turnId` e `willRetry` sem ler ou registrar a
  mensagem do erro.
- Quando `willRetry` é verdadeiro, ele continua aguardando o turno; apenas erro
  sem retry termina com `codex_turn_error_event`.
- A validação final da decisão, as allowlists, o isolamento e a proibição de
  retries no gateway/Qwen permanecem inalterados.

## Verificação

Os testes cobrem tanto a continuação após erro recuperável quanto o bloqueio de
erro terminal. Ainda é obrigatório fazer um único smoke real pelo Qwen com
tools após o deploy e acompanhar somente o JSONL privado.

## Atualização de 23/07/2026

O smoke pós-deploy continuou falhando com a mesma assinatura e revelou a causa
de fundo: o `outputSchema` com `oneOf` na raiz era rejeitado pelo structured
outputs, gerando erro terminal (`willRetry: false`). A correção do retry
permanece válida, mas não era suficiente. Ver
[o incidente do outputSchema](./2026-07-23-output-schema-rejeitado-structured-outputs.md).
