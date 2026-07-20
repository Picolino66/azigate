# Incidente: aliases CLI indisponíveis após o deploy

## Resumo

Em 20/07/2026, após o deploy coordenado do broker e do gateway v5, DeepSeek
continuou respondendo `200`, enquanto chamadas Qwen para
`claude-cli-opus-4.8` e `codex-cli-sol` receberam `502`. O broker permaneceu
`ready` e os dois providers passaram nos checks de binário, autenticação,
filesystem e flags. Severidade operacional: P2.

## Diagnóstico

- O `dist` instalado possui o mesmo hash do checkout validado.
- O processo systemd enxerga `.codex`, `.claude`, `.claude.json`, Bubblewrap,
  DNS e certificados com as permissões esperadas.
- O diagnóstico Claude Opus 4.8/medium chegou ao provider e retornou
  `CliProcessExitError_1_rate_limit`.
- Às 11:12 BRT, Codex CLI `0.133.0` retornou `invalid_request` para os três
  modelos GPT-5.6, enquanto GPT-5.5/5.4 produziram decisões válidas.
- Às 11:43 BRT, o binário foi atualizado para `0.144.6`; a UI e o catálogo
  embutido confirmaram Sol, Terra e Luna.
- Na versão `0.144.6`, smokes isolados de Sol, Terra e Luna no effort `medium`
  produziram 1/1 estrutura válida, 1/1 categoria e zero ferramenta local por
  modelo, usando exatamente o argv e Bubblewrap do broker.
- O upgrade também mudou `debug models`: o sentinela inválido passou a retornar
  exit code zero, incompatível com o check de capacidade antigo.

Nenhum prompt, resposta, stderr bruto, argumento de ferramenta ou credencial foi
registrado durante o diagnóstico.

## Causa

Foram dois eventos independentes:

1. a versão `0.133.0` recusava os slugs GPT-5.6 no modo `exec`; o upgrade
   `0.144.6` corrigiu o caminho funcional;
2. a conta Claude continua limitada pelo provider.

O `GET /health` prova capacidade do CLI e autenticação, não disponibilidade em
tempo real de cada modelo nem cota remota. A publicação correta continua sendo
controlada por `ALLOWED_MODELS` após o gate de cada modelo.

## Mitigação

- Instalar o novo `dist` com o check de catálogo definido pela
  [ADR-013](../../../adr/ADR-013-check-de-capacidade-codex-por-catalogo.md) antes
  de reiniciar o broker com Codex CLI `0.144.6`.
- Manter Sol/Terra/Luna na allowlist; os smokes funcionais foram aprovados. O gate
  completo por modelo continua pendente.
- Desabilitar Claude no gateway e no broker enquanto a conta retornar `429`, ou
  manter seus aliases fora de `ALLOWED_MODELS`.
- Evitar retries repetidos do Qwen durante o limite externo.

## Recuperação

Codex 5.5/5.4 e os três modelos GPT-5.6 estão funcionais no novo binário. O broker
em execução ainda conserva o health calculado antes do upgrade; o novo `dist`
precisa ser instalado antes do próximo restart. A recuperação Claude depende do
encerramento do rate limit externo.
