# ADR-009 — Claude CLI com modelo padrão e esforço configurável

## Status

Parcialmente superseded pelo ADR-010 em 18/07/2026 nos pontos relativos ao alias único, modelo padrão da conta e tratamento de effort incompatível. Os controles de isolamento e saída estruturada permanecem vigentes.

## Contexto

O provider Claude precisava ser publicado sem permitir que o cliente escolhesse binário, modelo arbitrário ou argumentos CLI. Ao mesmo tempo, clientes OpenAI-compatible (por exemplo o Qwen Code) oferecem `reasoning_effort`, e o Claude Code `2.1.214` suporta `--effort` com níveis fechados. O modelo efetivo deve continuar sendo o padrão da conta autenticada.

## Alternativas consideradas

1. Ignorar `reasoning_effort`: simples, mas a opção exibida pelo cliente não teria efeito.
2. Criar aliases Opus/Sonnet e aceitar argumentos livres: aumenta acoplamento, superfície de ataque e risco de divergência da conta.
3. Manter um alias e traduzir somente uma enum fechada para `--effort`: preserva a fronteira e oferece o controle necessário.

## Decisão

- O único alias público é `claude-cli` e ele não envia `--model`.
- Para esse alias, o gateway aceita `reasoning_effort` igual a `low`, `medium`, `high`, `xhigh` ou `max`.
- Omitir o campo preserva o padrão automático da conta. Um valor inválido recebe `400 invalid_cli_request`.
- O protocolo privado passa à versão 3 com `effort` opcional somente para `provider=claude`; Codex recusa o campo.
- O broker constrói `--effort <nível>` por argv fixo. Nenhum argumento arbitrário é aceito.
- O esforço controla apenas o raciocínio interno. Thinking/reasoning não é publicado no JSON ou SSE.
- A publicação depende do gate completo da versão instalada e de smokes dos demais níveis.

## Trade-offs

O contrato fica dependente dos cinco nomes suportados pelo Claude Code e exige uma migração coordenada gateway/broker ao protocolo v3. Em troca, o cliente obtém um seletor real sem controlar o modelo nem ampliar a capacidade de execução.

## Consequências

- Releases do Claude Code exigem nova checagem de flags e repetição do gate.
- Níveis não suportados pelo modelo podem ser reduzidos pelo próprio Claude Code.
- O upstream continua opaco, o Codex mantém o comportamento atual e não existe fallback entre providers.
- Broker v2 e gateway v3 não são interoperáveis; o deploy deve atualizar os dois juntos.
