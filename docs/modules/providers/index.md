# Providers

## Descrição

Registry multiprovedor que mantém um upstream OpenAI-compatible (DeepSeek por padrão) e oferece aliases experimentais para CLIs locais sem transferir a execução de ferramentas para o servidor.

## Localização no código

- `src/providers/`: roteamento, validação, cliente do broker e respostas OpenAI.
- `src/broker/`: protocolo e serviço host isolado.
- `src/upstream/`: adaptador de upstream (DeepSeek por padrão).

## Entrada

`model`, `messages`, `tools`, `tool_choice`, `parallel_tool_calls` e `stream` em `POST /v1/chat/completions`.

## Saída

Chat Completion JSON, SSE do upstream opaco ou SSE CLI sintético. O catálogo expõe modelos do upstream e aliases saudáveis.

## Dependências

Fastify, Undici, Unix socket, Bubblewrap e os binários Codex/Claude instalados no host.

## Regras de negócio

- Não há fallback automático.
- Aliases reservados nunca são enviados ao upstream.
- O agente cliente é o único executor de ferramentas.
- Um alias só é publicado se habilitado e saudável.
- O broker não aceita localização, comando ou ambiente do cliente.
- O broker pode reutilizar sessões somente em RAM quando houver um único prefixo
  exato; o gateway HTTP permanece stateless.
- Transcript CLI acima do limite recebe `413`, sem truncamento.

## Fluxo resumido

Autenticar -> aplicar allowlists -> resolver provider -> executar o adaptador -> validar/normalizar a resposta -> devolver ao agente.

## Possíveis erros

`model_not_allowed`, `invalid_cli_request`, `cli_context_too_large`, `cli_busy`,
`invalid_cli_output`, `cli_execution_failed`, `cli_unavailable`,
`providers_unavailable` e `cli_timeout`.

## Features

- [Upstream OpenAI-compatible (DeepSeek por padrão)](./deepseek.md)
- [Codex CLI](./codex-cli.md)
- [Claude CLI](./claude-cli.md)
- [Sessões CLI efêmeras em memória](./sessoes-cli-em-memoria.md)
