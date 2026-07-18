# Arquitetura do gateway-ai

## Contexto

O Qwen Code executado no computador da VPN usa uma API OpenAI Compatible. O gateway escolhe um provedor pelo `model`, mas nunca executa as ferramentas oferecidas pelo Qwen.

```text
PC da VPN
  Qwen Code + VS Code + repositórios
  lê arquivos, confirma ações, executa comandos e aplica alterações
             │ HTTPS/LAN
             ▼
Servidor
  Nginx -> container gateway-ai
              ├── DeepSeek adapter -> HTTPS api.deepseek.com
              └── CLI adapter -> Unix socket 0600 -> broker host
                                                   └── Bubblewrap -> Codex/Claude
             │
             ▼
  Chat Completion/texto/tool calls
             │
             ▼
  Qwen executa somente no PC da VPN
```

## Padrão e módulos

O gateway continua um monólito modular e stateless. O broker é um serviço host auxiliar, privado:

- `config`: configuração e secrets do processo HTTP;
- `security`: autenticação, allowlist e rate limit local;
- `providers/registry`: registry fechado dos aliases e roteamento sem fallback;
- `upstream`: adaptador DeepSeek, único construtor de URLs HTTPS;
- `providers/broker-client`: cliente HTTP sobre Unix socket;
- `providers/cli-request`: validação e tradução do contrato OpenAI para o protocolo interno;
- `providers/openai-response`: Chat Completions e SSE sintéticos dos CLIs;
- `broker`: capacidade, protocolo, prompt, isolamento, subprocessos e servidor host;
- `models`: catálogo DeepSeek cacheado combinado com aliases CLI saudáveis;
- `observability`: métricas e logs somente de metadados, com destaque ANSI do campo `model` para
  `deepseek-v4-flash`, `deepseek-v4-pro` e aliases `codex-cli-*` no stdout padrão.

Não há banco, fila, frontend, proxy genérico ou estado de conversa. Rate limit e cache continuam locais a cada processo.

## Registry e disponibilidade

- `codex-cli-sol`, `codex-cli-terra`, `codex-cli-luna`, `codex-cli-5.5`, `codex-cli-5.4`, o legado `codex-cli` e `claude-cli` são reservados mesmo quando desabilitados; nunca caem na DeepSeek.
- Os aliases Codex escolhem modelos internos fixos por allowlist; `codex-cli` permanece sinônimo de `gpt-5.4`.
- Qualquer outro ID permitido é encaminhado ao adaptador DeepSeek.
- Não existe fallback automático entre provedores.
- `/v1/models` combina o catálogo DeepSeek com aliases habilitados e saudáveis.
- Se a DeepSeek falhar, os aliases locais continuam listados. Se nenhum provedor estiver utilizável, a resposta é `503`.
- `/ready` considera a DeepSeek configurada quando `READY_CHECK_UPSTREAM=false`; com a checagem ativa, basta DeepSeek ou um alias CLI estar saudável.

## Broker e isolamento

O protocolo v3 oferece somente `GET /health` e `POST /execute` em Unix socket. Sua entrada é reconstruída pelo gateway e contém request ID, provedor, modelo Codex validado, esforço Claude opcional em enum fechada, mensagens textuais, function tools, `tool_choice` e `parallel_tool_calls`. Cwd, path de host, URL, comando, argv e ambiente não pertencem ao contrato.

Cada execução:

1. verifica se o provedor passou os checks de binário, autenticação, flags e Bubblewrap;
2. adquire a única vaga global ou retorna `cli_busy` sem fila;
3. cria `/work` descartável, schema, settings e MCP vazio;
4. executa Bubblewrap por `spawn`, com argv fixo, `shell: false` e ambiente limpo;
5. limita stdout+stderr a 4 MiB e o tempo a 10 minutos;
6. recusa eventos que indiquem ferramenta local e valida a decisão final;
7. remove o workspace; cancelamento envia `SIGTERM` ao grupo e `SIGKILL` após 2 segundos.

Somente o diretório de autenticação do CLI selecionado entra na sandbox. Nenhum repositório, home completo do operador ou secret do gateway entra nela.

## Dois regimes de streaming

- DeepSeek: bytes SSE são copiados imediatamente, inclusive keep-alive, campos futuros, usage e `[DONE]`.
- Codex/Claude: heartbeat a cada 15 segundos; a decisão é bufferizada até o limite, validada e emitida atomicamente. Falha depois do heartbeat gera `event: error` sanitizado e encerra sem `[DONE]`.

## Fronteiras de confiança

1. Qwen -> Nginx: tráfego não confiável, HTTPS, Bearer, IP/model allowlists e limites.
2. Nginx -> container: rede local ainda autenticada; somente quatro rotas públicas.
3. Container -> DeepSeek: HTTPS, paths tipados e credencial reconstruída.
4. Container -> broker: Unix socket read-only no mount, UID igual e protocolo fechado.
5. Broker -> CLI: subprocesso não confiável, Bubblewrap, ambiente mínimo e saída validada.
6. Auth dirs -> CLI: credenciais necessárias, nunca montadas no container nem registradas.

## Decisões

- [ADR-005](../adr/ADR-005-registro-multiprovedor-e-broker-local.md): registry e broker host.
- [ADR-006](../adr/ADR-006-qwen-como-unico-executor.md): Qwen como único executor.
- [ADR-007](../adr/ADR-007-streaming-dividido-por-provedor.md): streaming por tipo de provedor.
- [ADR-008](../adr/ADR-008-aliases-codex-com-modelo-fixo.md): seleção Codex por aliases fechados.
- [ADR-009](../adr/ADR-009-claude-cli-esforco-configuravel.md): Claude no modelo padrão com esforço fechado.

## Referências de integração

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode.md)
- [Claude CLI usage](https://code.claude.com/docs/en/cli-usage)
- [Qwen Code model providers](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/)
