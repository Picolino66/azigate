# ADR-023 — Worker remoto, isolamento de workspace e ferramentas via MCP

- Status: aceito
- Fase: F2 (evolução arquitetural, ciclo `native-agent-plane`)
- Data: 25/09/2026
- Relaciona-se com: ADR-022, ADR-024

## Contexto

O cenário-alvo do `v2.md` separa as máquinas:

- **máquina A**: `azigate-agentd`, CLIs Codex/Claude/AGY e suas credenciais;
- **máquina B**: o projeto, Git, toolchains, testes e Docker.

As ferramentas nativas do agente na máquina A (Read, Write, Edit, Bash) não podem tocar o
projeto, porque ele está em B, e não devem tocar A. A máquina B costuma estar atrás de
NAT, CGNAT, firewall doméstico ou VPN, então não se deve exigir porta pública nela.

Restrições observadas nas CLIs instaladas:

- Claude Code 2.1.280 oferece `--tools ""` (desliga todas as ferramentas embutidas),
  `--mcp-config <arquivo>`, `--strict-mcp-config`, `--allowedTools` e
  `--permission-prompt-tool stdio`. Ferramentas MCP passam pelo mesmo fluxo de
  permissão (`can_use_tool`).
- AGY 1.2.10 só configura MCP globalmente (`agy mcp add`), não por sessão, e o headless
  não tem canal de aprovação.
- Codex 0.144.6 marca `codex exec-server` como `[EXPERIMENTAL]`; o registro remoto
  (`--remote`, `--environment-id`, `--use-agent-identity-auth`) depende de identidade
  de agente da OpenAI, e `codex features list` não expõe flag estável de ambiente
  remoto.

## Alternativas consideradas

1. **Abrir porta no worker e o gateway conectar nele.** Exige exposição pública ou VPN
   em B. Rejeitada.
2. **Montar o projeto de B em A (SSHFS/NFS).** Ferramentas nativas funcionariam, mas o
   agente ganharia acesso ao filesystem de A e comandos rodariam em A com a toolchain
   errada. Rejeitada.
3. **Worker com conexão WebSocket de saída e RPC tipado, exposto ao agente como servidor
   MCP (escolhida).** B inicia a conexão; o gateway nunca entra em B; o agente continua
   completo e só troca as ferramentas de arquivo/shell pelas do worker.

## Decisão

1. **Transporte.** `azigate-worker` conecta em `WS(S) /worker/v1/connect` no agentd,
   autenticado por `Authorization: Bearer <token de worker>`. Em produção a URL deve ser
   `wss://`; `ws://` só para loopback em desenvolvimento. Heartbeat periódico; o agentd
   descarta workers silenciosos. Reconexão com backoff exponencial limitado.
2. **Identidade do worker.** Token HMAC-SHA256 assinado com `WORKER_TOKEN_SECRET`
   (≥ 32 caracteres), contendo `workerId`, escopos `worker:connect` e
   `workspace:<id>` e expiração. `npm run worker:token` gera tokens. O worker não pode
   declarar outro `workerId` nem expor workspace fora dos seus escopos. O token fica em
   arquivo (`tokenFile`), nunca em argv, porque argv é visível em `ps`.
   `WORKER_TOKEN_SECRET`, `AGENT_API_KEYS` e `GATEWAY_API_KEYS` são disjuntos.
3. **Workspace por ID.** O path real existe apenas na configuração local do worker.
   Toda operação de arquivo faz `realpath` do alvo (ou do ancestral existente mais
   próximo, para criação), resolve symlinks e exige prefixo dentro da raiz; paths
   absolutos, `~` e bytes nulos são recusados. Nenhum path de B trafega para A.
4. **RPC fechado.** Métodos: `list_directory`, `find_file`, `search`, `read_file`,
   `write_file`, `edit_file`, `mkdir`, `delete`, `git_status`, `git_diff`, `git_log`,
   `shell_exec`, `process_start`, `process_stdin`, `process_output` e `process_kill`.
   Qualquer outro método recebe `method_not_found`.
5. **Execução desligada por padrão.** `shell_exec` e `process_*` só funcionam com
   `exec.enabled: true` na configuração do worker e, se `exec.allowedCommands` existir,
   com `argv[0]` na allowlist. A execução usa `spawn` sem shell, `argv` explícito,
   `cwd` dentro do workspace, ambiente mínimo, grupo de processos, timeout e limite de
   saída. **A jail lógica vale para operações de arquivo, não para o efeito de um
   programa**: um processo permitido roda com os privilégios do usuário do worker. Por
   isso a execução exige aprovação no agente e a documentação recomenda um usuário
   dedicado.
6. **Ferramentas para o Claude via MCP.** Em sessões com `worker`, o Claude roda com
   `--tools ""`, `--strict-mcp-config` e `--mcp-config` apontando para um arquivo `0600`
   em diretório `0700` da sessão. O servidor MCP é `azigate-mcp-bridge` (stdio), que
   fala com o agentd por socket Unix privado (`0600`) usando um token de capacidade
   aleatório por sessão. As ferramentas somente leitura entram em `--allowedTools`; as
   de escrita e execução passam por `can_use_tool` e, portanto, pela aprovação do
   Azigate. O agentd ainda impõe o modo: `plan` recusa escrita e execução mesmo que o
   agente tente.
7. **Adiado com evidência.** AGY remoto (Fase 7 do `v2.md`) e Codex `exec-server`
   remoto (Fase 8) não entram nesta entrega: o AGY não aceita MCP por sessão nem
   aprovação headless, e o registro remoto do Codex é experimental e acoplado à
   identidade da OpenAI. Sessões `agy` ou `codex` com `worker` recebem
   `400 worker_not_supported_for_provider`.

## Trade-offs

- MCP adiciona um salto (Claude → bridge → agentd → worker) e latência por chamada de
  ferramenta, em troca de nunca expor B nem executar ferramentas em A.
- As ferramentas do worker são mais simples que as nativas (sem LSP, sem notebooks).
- Token HMAC é stateless: revogar um token individual exige rotação do segredo ou
  expiração curta.

## Consequências

- Nova fronteira de confiança agentd ↔ worker e agentd ↔ bridge no threat model.
- Protocolo em [`specs/worker-protocol.md`](../specs/worker-protocol.md).
- Documentação operacional em [`docs/modules/agents/worker.md`](../docs/modules/agents/worker.md).
