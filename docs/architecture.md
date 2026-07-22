# Arquitetura do azigate

## Contexto

Um agente cliente OpenAI-compatible (por exemplo Qwen Code, GitHub Copilot, Cline ou
Continue) usa uma API no formato OpenAI. O gateway escolhe um provedor pelo `model`,
mas nunca executa as ferramentas oferecidas pelo agente.

```text
Computador do agente cliente
  Agente OpenAI-compatible + VS Code + repositórios
  lê arquivos, confirma ações, executa comandos e aplica alterações
             │ HTTPS/rede
             ▼
Servidor (self-hosted, onde você quiser)
  Nginx -> container azigate
              ├── adaptador de upstream -> HTTPS (upstream OpenAI-compatible,
              │                                     DeepSeek por padrão)
              └── adaptador CLI -> Unix socket 0600 -> broker host
                                                     └── Bubblewrap -> Codex/Claude
             │
             ▼
  Chat Completion/texto/tool calls
             │
             ▼
  O agente executa somente no seu computador
```

## Padrão e módulos

O gateway HTTP continua um monólito modular e stateless. O broker é um serviço
host auxiliar privado e pode manter sessões efêmeras somente em RAM:

- `config`: configuração e secrets do processo HTTP;
- `security`: autenticação, allowlist e rate limit local;
- `providers/registry`: registry fechado dos aliases e roteamento sem fallback;
- `upstream`: adaptador de upstream (`DeepSeekClient`), único construtor de URLs HTTPS;
- `providers/broker-client`: cliente HTTP sobre Unix socket;
- `providers/cli-request`: validação e tradução do contrato OpenAI para o protocolo interno;
- `providers/openai-response`: Chat Completions e SSE sintéticos dos CLIs;
- `broker`: capacidade, protocolo, prompt estável, correlação semântica, sessões em
  memória, isolamento, subprocessos e servidor host;
- `models`: catálogo do upstream cacheado combinado com aliases CLI saudáveis;
- `observability`: métricas, stdout e JSONL privado somente de metadados; cada alias conhecido recebe uma cor ANSI
  própria no campo `model`, e o `effort` registrado para Claude é o valor normalizado efetivamente usado.

Não há banco, fila, frontend, proxy genérico nem persistência de conversa. As
sessões do broker têm TTL/LRU, desaparecem em restart e guardam somente hashes de
correlação e handles dos processos. Rate limit e caches continuam locais.

O upstream é fixo e opaco para o cliente, mas configurável pelo operador em
`DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY` (nomes históricos). Por padrão a DeepSeek;
pode ser qualquer API OpenAI-compatible (OpenAI, OpenRouter, Together, Groq, Mistral,
ou local via Ollama/LM Studio/vLLM) que exponha `models` e `chat/completions`.

## Registry e disponibilidade

- Os aliases Codex e Claude definidos no catálogo central são reservados mesmo quando desabilitados; nunca caem no upstream.
- Os aliases Codex escolhem modelos internos fixos por allowlist; `codex-cli` permanece sinônimo de `gpt-5.4`. Effort público é normalizado para uma configuração fechada do subprocesso.
- Os aliases Claude escolhem oito modelos completos; `claude-cli` permanece sinônimo de `claude-sonnet-4-6`. A `ALLOWED_MODELS` publica somente modelos aprovados nos gates reais.
- Qualquer outro ID permitido é encaminhado ao adaptador de upstream.
- Não existe fallback automático entre provedores.
- `/v1/models` combina o catálogo do upstream com aliases habilitados e saudáveis.
- Se o upstream falhar, os aliases locais continuam listados. Se nenhum provedor estiver utilizável, a resposta é `503`.
- `/ready` considera o upstream configurado quando `READY_CHECK_UPSTREAM=false`; com a checagem ativa, basta o upstream ou um alias CLI estar saudável.

## Broker e isolamento

O protocolo v6 oferece somente `GET /health` e `POST /execute` em Unix socket. Sua
entrada é reconstruída pelo gateway e contém request ID, provedor, modelo CLI
validado, effort efetivo, mensagens textuais, function tools, `tool_choice` e
`parallel_tool_calls`. Cwd, path de host, URL, comando, argv e ambiente não
pertencem ao contrato.

Cada request:

1. verifica se o provedor passou os checks de binário, autenticação, flags e Bubblewrap;
2. adquire a única vaga global ou retorna `cli_busy` sem fila;
3. rejeita mensagens+tools acima de 256 KiB, sem truncar;
4. tenta correlacionar um único prefixo exato por hashes SHA-256, normalizando IDs
   de tool calls; divergência ou ambiguidade cria sessão nova;
5. cria `/work` e home descartáveis, settings/MCP vazios e monta somente o arquivo
   de autenticação necessário;
6. usa um App Server Codex com threads efêmeras ou um processo Claude `stream-json`
   persistente; o primeiro turno recebe tudo e os seguintes somente o delta;
7. limita a saída de cada turno a 4 MiB e o tempo a 10 minutos, recusa eventos de
   ferramenta local, registra fases/reasons sanitizados e valida a decisão final;
8. cancelamento interrompe o turno Codex ou encerra o grupo Claude; TTL, eviction,
   crash e restart eliminam a sessão.

Somente `~/.codex/auth.json` ou `~/.claude/.credentials.json` entra na sandbox em
modo de sessão. Para Claude, o arquivo top-level é validado como regular, privado,
pertencente ao usuário do broker e limitado a 1 MiB, então copiado para o home
efêmero. Nenhum repositório, home completo, histórico/configuração Codex do
operador ou secret do gateway entra nela. O modo `stateless` de contingência
preserva o isolamento anterior.

## Usage e cache

- Claude: `promptTokens = input + cache_creation + cache_read`.
- Codex: `promptTokens = input`; `cached_input_tokens` é subconjunto e
  `freshInputTokens = input - cached`.
- Reasoning Codex é subconjunto da saída, nunca parcela adicional.
- `totalTokens` é volume lógico, não porcentagem da cota do plano.
- Detalhes de cache, custo estimado, reuso e bytes ficam em logs/métricas; a
  resposta OpenAI conserva somente os três campos padrão.

## Dois regimes de streaming

- Upstream (passthrough): bytes SSE são copiados imediatamente, inclusive keep-alive, campos futuros, usage e `[DONE]`.
- Codex/Claude: heartbeat a cada 15 segundos; a decisão é bufferizada até o limite, validada e emitida atomicamente. Falha depois do heartbeat gera `event: error` sanitizado e encerra sem `[DONE]`.

## Fronteiras de confiança

1. Agente cliente -> Nginx: tráfego não confiável, HTTPS, Bearer, IP/model allowlists e limites.
2. Nginx -> container: rede local ainda autenticada; somente quatro rotas públicas.
3. Container -> upstream: HTTPS, paths tipados e credencial reconstruída.
4. Container -> broker: Unix socket read-only no mount, UID igual e protocolo fechado.
5. Broker -> CLI: subprocesso não confiável, Bubblewrap, ambiente mínimo e saída validada.
6. Auth dirs/config -> CLI: credenciais necessárias, nunca montadas no container
   nem registradas; a configuração Claude é somente leitura no serviço e efêmera
   na sandbox.
7. Broker -> log de execução: JSONL privado com enum fechada de fases/reasons; não
   contém conteúdo de conversa, saída CLI, argumentos, stderr ou paths privados.

## Decisões

- [ADR-005](../adr/ADR-005-registro-multiprovedor-e-broker-local.md): registry e broker host.
- [ADR-006](../adr/ADR-006-qwen-como-unico-executor.md): agente cliente como único executor.
- [ADR-007](../adr/ADR-007-streaming-dividido-por-provedor.md): streaming por tipo de provedor.
- [ADR-008](../adr/ADR-008-aliases-codex-com-modelo-fixo.md): seleção Codex por aliases fechados.
- [ADR-009](../adr/ADR-009-claude-cli-esforco-configuravel.md): Claude no modelo padrão com esforço fechado.
- [ADR-010](../adr/ADR-010-aliases-claude-com-modelo-fixo.md): aliases Claude com modelo e effort fixados.
- [ADR-011](../adr/ADR-011-effort-qwen-para-provedores-cli.md): formatos de effort do Qwen e normalização Codex/Claude.
- [ADR-012](../adr/ADR-012-configuracao-claude-em-home-efemero.md): configuração Claude em home efêmero.
- [ADR-013](../adr/ADR-013-check-de-capacidade-codex-por-catalogo.md): check Codex por catálogo estruturado.
- [ADR-014](../adr/ADR-014-sessoes-cli-efemeras-em-memoria-e-usage-por-provider.md): sessões efêmeras e contabilização provider-specific.
- [ADR-015](../adr/ADR-015-telemetria-segura-e-schema-decisao-cli.md): telemetria sanitizada e schema por request.

## Referências de integração

- [Codex App Server](https://developers.openai.com/codex/app-server/)
- [Claude CLI usage](https://code.claude.com/docs/en/cli-usage)
- [Qwen Code model providers](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/)
