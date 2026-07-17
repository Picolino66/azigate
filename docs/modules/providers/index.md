# Providers

## Descrição

Registry multiprovedor que mantém a DeepSeek e oferece aliases experimentais para CLIs locais sem transferir a execução de ferramentas para o servidor.

## Localização no código

- `src/providers/`: roteamento, validação, cliente do broker e respostas OpenAI.
- `src/broker/`: protocolo e serviço host isolado.
- `src/upstream/`: adaptador DeepSeek.

## Entrada

`model`, `messages`, `tools`, `tool_choice`, `parallel_tool_calls` e `stream` em `POST /v1/chat/completions`.

## Saída

Chat Completion JSON, SSE DeepSeek opaco ou SSE CLI sintético. O catálogo expõe modelos DeepSeek e aliases saudáveis.

## Dependências

Fastify, Undici, Unix socket, Bubblewrap e os binários Codex/Claude instalados no host.

## Regras de negócio

- Não há fallback automático.
- Aliases reservados nunca são enviados à DeepSeek.
- Qwen Code é o único executor de ferramentas.
- Um alias só é publicado se habilitado e saudável.
- O broker não aceita localização, comando ou ambiente do cliente.

## Fluxo resumido

Autenticar -> aplicar allowlists -> resolver provider -> executar o adaptador -> validar/normalizar a resposta -> devolver ao Qwen.

## Possíveis erros

`model_not_allowed`, `invalid_cli_request`, `cli_busy`, `invalid_cli_output`, `cli_execution_failed`, `cli_unavailable`, `providers_unavailable` e `cli_timeout`.

## Features

- [DeepSeek](./deepseek.md)
- [Codex CLI](./codex-cli.md)
- [Claude CLI](./claude-cli.md)
