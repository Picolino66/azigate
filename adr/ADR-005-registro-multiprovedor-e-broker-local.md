# ADR-005 — Registro multiprovedor e broker local

- Status: aceito
- Fase: reavaliação F2/F3
- Data: 16/07/2026
- Substitui parcialmente: ADR-002

## Contexto

O gateway precisa manter a DeepSeek e oferecer aliases para sessões autenticadas do Codex CLI e, em uma fase posterior, do Claude CLI. O container HTTP não deve receber credenciais dos CLIs nem acesso ao host. Os clientes não podem escolher destino, comando ou argumentos de processo.

## Opções consideradas

- Executar os CLIs dentro do container: simplifica o deploy, mas mistura credenciais e amplia a fronteira de confiança do gateway público.
- Executar os CLIs diretamente no processo Fastify: reduz componentes, mas concede ao container acesso a processos, home e ferramentas do host.
- Usar broker host isolado por Unix socket: mantém credenciais fora do container e permite aplicar concorrência, cancelamento e sandbox em uma fronteira privada.

## Decisão

Adotar um registry fechado por `model`. IDs não reservados continuam no adaptador DeepSeek. `codex-cli` e `claude-cli` são aliases reservados, publicados somente quando habilitados e saudáveis. O gateway conversa com um broker host versionado por Unix socket, com apenas `GET /health` e `POST /execute`.

O protocolo interno aceita somente request ID, provedor, histórico textual, function tools, `tool_choice` e `parallel_tool_calls`. URL, cwd, path, comando, argv e ambiente nunca fazem parte do contrato. Não existe fallback automático entre provedores.

## Trade-offs e consequências

O broker acrescenta uma unidade operacional e exige que o UID do container consiga acessar o socket `0600`. Em troca, o container não recebe os logins Codex/Claude e o broker não recebe as chaves DeepSeek/gateway. A disponibilidade de cada alias depende de um gate de capacidade da versão instalada.
