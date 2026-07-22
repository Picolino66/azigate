# Incidente: falhas genéricas de decisão Codex e Claude

## Resumo

Em 22/07/2026, chamadas do Qwen receberam `invalid_cli_output` do Codex e
`cli_execution_failed` do Claude. Depois do heartbeat SSE, o gateway já havia
aberto a resposta HTTP e enviou o erro sanitizado como `event: error`, sem
`[DONE]`. Severidade operacional: P2.

## Evidência

- Codex 0.144.6: decisões rejeitadas como `InvalidCliOutputError`.
- Claude Code 2.1.215: resultado final não bem-sucedido após 229 s, classificado
  inicialmente como `CliExecutionFailedError`.
- Os transcripts observados estavam abaixo de 256 KiB e os tempos abaixo do limite
  de 10 minutos.

Nenhum prompt, resposta, argumento de tool, stdout, stderr ou credencial foi
registrado durante a investigação.

## Causa raiz

O broker condensava motivos distintos em duas classes públicas genéricas e o
schema estático permitia formatos que a validação semântica posterior recusava.
No Claude 2.1.215, subtypes finais como
`error_max_structured_output_retries` não recebiam classificação interna.

## Correção

- ADR-015 introduziu reasons internas fechadas e JSONL privado durante a execução.
- O schema passou a ser gerado por request, impondo texto XOR tools, tools
  oferecidas, `tool_choice` e paralelismo.
- Codex e Claude mantêm validação final e fail-closed para eventos locais ou
  desconhecidos.
- O JSONL usa diretório `0700`, arquivos `0600` e rotação limitada; contém apenas
  metadados e reasons sanitizadas.

## Verificação

- `npm run check`: 175 testes, lint, typecheck e build aprovados.
- Cobertura: 82.06% statements, 78.54% branches, 87.96% functions e 87.47% lines.
- `npm audit --omit=dev --audit-level=high`: sem vulnerabilidades altas após
  atualização transitiva do lockfile.

## Pendências operacionais

O deploy coordenado e os gates reais por versão/modelo/modo continuam manuais e
pendentes. Até a validação real, `stateless` permanece o rollback explícito por
provider.
