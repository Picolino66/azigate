# ADR-025 — Workspace Server via MCP para Claude, Codex e AGY, e separação explícita dos planos

- Status: aceito
- Fase: F2 (reavaliação arquitetural, ciclo `native-agent-plane-workspace`)
- Data: 25/09/2026
- Substitui parcialmente: ADR-023 (decisões 4, 6 e 7 — protocolo das ferramentas remotas,
  transporte MCP e o adiamento de Codex/AGY remotos)
- Relaciona-se com: ADR-022, ADR-024

## Contexto

A primeira entrega do Agent Plane só levava o **Claude** a um projeto em outra máquina; Codex e
AGY ficavam presos a workspaces da máquina A (ADR-023, decisão 7). O requisito corrigido do
operador é outro: os **três** agentes completos rodam na máquina A e operam o projeto que
continua na máquina B, e isso não pode ser confundido com o Model Plane.

Três níveis precisam ficar separados:

| Nível | Exemplos | Onde roda |
|---|---|---|
| Modelo | GPT, Claude, Gemini, DeepSeek | provedores |
| Harness de agente | Qwen Code, Cline, Claude Code, Codex, AGY | Model Plane: máquina B; Agent Plane: máquina A |
| Ambiente de execução | arquivos, shell, git, testes, projeto | máquina B |

> **Model Plane permite que agentes locais usem modelos remotos. Native Agent Plane permite
> que agentes remotos completos usem ambientes de execução locais.**

Evidência coletada nas CLIs reais em 25/09/2026 (sondagens sem cota e três turnos mínimos):

- **Claude Code 2.1.280**: `--tools "Task,TodoWrite,WebFetch,WebSearch"` mantém subagentes e
  remove Read/Write/Edit/Bash (confirmado pelo `system/init`); `--mcp-config` e
  `--strict-mcp-config` funcionam; `can_use_tool` cobre ferramentas MCP.
- **Codex 0.144.6**: aceita servidor MCP por `-c mcp_servers.<nome>.*`
  (`command`, `args`, `env`, `default_tools_approval_mode` ∈ `auto|prompt|writes|approve`);
  desliga `shell_tool`, `unified_exec`, `browser_use`, `browser_use_external`,
  `computer_use` e `in_app_browser` por `--disable`; para desligar um servidor MCP do usuário é
  preciso reenviar o transporte (`url` ou `command`) junto com `enabled=false`.
- **AGY 1.2.11**: não aceita MCP por sessão (o `mcpServers` do frontmatter de agente não
  carregou em nenhum formato testado), mas servidores globais (`agy mcp add`) **sobem no
  startup, com cwd do processo `agy` e herdando o ambiente dele**; um agente de usuário com
  `excludeDefaultComponents: true` perde as ferramentas embutidas e mantém a meta-ferramenta
  `call_mcp_tool`; em headless, chamadas MCP são negadas sem a regra
  `mcp(<servidor>/<ferramenta>)` em `permissions.allow`; o servidor MCP recebe um
  `server/discover` não padronizado antes do `initialize`.
- A configuração AGY deste host é permissiva (`permissionPreset TURBO`, acesso a arquivos fora do
  workspace liberado): confiar só no modo de revisão deixaria o agente ler a máquina A.

## Alternativas consideradas

1. **Copiar ou montar o projeto em A** (git clone, rsync, sshfs). Viola o requisito de o projeto
   continuar em B e executa toolchain na máquina errada. Rejeitada.
2. **Usar Qwen/Cline em B como executor dos agentes de A.** Quem controlaria o loop seria o
   Qwen, não o Claude/Codex/AGY. Rejeitada.
3. **Codex `exec-server` para o Codex e MCP para os demais.** O registro remoto do
   `exec-server` é experimental e acoplado à identidade de agente da OpenAI; exigiria um segundo
   caminho paralelo só para um agente. Rejeitada nesta versão.
4. **Um Workspace Server genérico que fala MCP, alcançado por relay (escolhida).** Os três
   agentes usam o mesmo servidor; qualquer outro cliente MCP também pode usá-lo.

## Decisão

1. **Workspace Server (`azigate-workspace`)**, antigo `azigate-worker` (o nome antigo continua
   como alias de script e de entrypoint). Roda na máquina B, não chama modelo, não decide nada e
   é **o servidor MCP de verdade**: `tools/list` e `tools/call` com as ferramentas do workspace,
   anotadas com `readOnlyHint`/`destructiveHint`. Dois modos: conexão de saída para o agentd
   (canais MCP multiplexados no WebSocket: `mcp.open`, `mcp.message`, `mcp.close`) e
   `--mcp-stdio`, para um cliente MCP da própria máquina B.
2. **Relay no agentd**. A ponte stdio (`azigate-mcp-bridge`) que o agente inicia em A virou um
   cano: envia `{"type":"hello","token":…}` pelo socket Unix `0600` e depois repassa JSON-RPC.
   O agentd autentica o token, abre o canal até o workspace de B e **aplica a política** em
   `tools/call`: `plan` recusa escrita e execução; aprovação pelo gateway quando o agente não
   tem canal próprio.
3. **Token só em arquivo**. O agentd grava `mcp-session.json` (`0600`, no diretório `0700` da
   sessão) com socket e token; a configuração MCP que o agente recebe tem apenas o caminho desse
   arquivo (`AZIGATE_MCP_SESSION`). Sem essa variável, a ponte expõe zero ferramentas.
4. **Claude**: `--tools "Task,TodoWrite,WebFetch,WebSearch"`, `--strict-mcp-config`,
   `--mcp-config` com a ponte, `--allowedTools` com as ferramentas somente leitura,
   `--append-system-prompt` com a localização do projeto; aprovação **nativa** (`can_use_tool`).
5. **Codex**: `codex app-server` com os recursos locais desligados, servidor MCP injetado por
   `-c`, `default_tools_approval_mode="approve"`, servidores MCP do usuário desligados (com o
   transporte reenviado), thread com cwd vazio e privado, `sandbox: read-only` e
   `developerInstructions`; aprovação **pelo gateway**. Pedidos nativos de comando/arquivo numa
   sessão remota são sempre negados (rodariam em A); elicitação MCP vira aprovação do Azigate.
6. **AGY**: o agentd prepara, de forma idempotente e só com nomes do Azigate, o servidor global
   `azigate_workspace` (`agy mcp add`), o agente `azigate-workspace` (`excludeDefaultComponents:
   true`) e as regras `mcp(azigate_workspace/<ferramenta>)`; a sessão roda com
   `--agent azigate-workspace`, cwd vazio e `AZIGATE_MCP_SESSION` no ambiente; aprovação **pelo
   gateway**. `AGY_REMOTE_AUTO_SETUP=false` desliga a preparação automática;
   `npm run agy:remote -- install|status|uninstall` opera manualmente.
7. **Cliente `azigate-agent`** na máquina B (ou qualquer lugar): cria a sessão, detecta o
   Workspace Server que expõe o workspace, mostra streaming, ferramentas (`READ`, `RUN`…) e
   aprovações y/N, aceita vários turnos, cancela com Ctrl+C e encerra.
8. **Separação explícita no código**: regras de ESLint (`no-restricted-imports`) proíbem o
   Model Plane de importar o Agent Plane e vice-versa; só `config`, `security` e
   `observability` são compartilhados.
9. **Eventos**: `tool.started` ganha `summary`; ferramentas remotas aparecem como
   `mcp__azigate_workspace__<ferramenta>` nos três providers (o `call_mcp_tool` do AGY é
   normalizado).

## Trade-offs

- A preparação do AGY altera a configuração global da CLI no host A (servidor MCP, agente e 16
  regras com o prefixo do Azigate). Fora de uma sessão Azigate a ponte não expõe ferramentas,
  então as regras não liberam nada; ainda assim é uma alteração fora do repositório,
  documentada e reversível.
- Em sessão remota, os subagentes embutidos do AGY não ficam disponíveis (fazem parte dos
  componentes padrão que acessariam a máquina A). Claude mantém `Task`; Codex mantém
  multiagente.
- `WebFetch`/`WebSearch` do Claude e a busca web do Codex continuam saindo pela rede da máquina
  A, sujeitos às permissões de cada agente.
- MCP acrescenta um salto por ferramenta (agente → ponte → relay → worker).

## Consequências

- ADR-023 continua válido para identidade, transporte, jail e execução do worker; o adiamento de
  Codex/AGY remotos fica apenas como histórico.
- Contratos atualizados: `specs/agent-api.md` e `specs/workspace-protocol.md` (antigo
  `worker-protocol.md`).
- Suíte comum `test/workspace-compat.test.ts` e validação real
  `npm run test:agents:remote-real`.

## Adendo (29/09/2026): distribuição para a máquina B

**Contexto.** O operador não quer clonar o repositório do Azigate na máquina do projeto só para
ter o Workspace Server e o cliente.

**Alternativas.** (1) Clonar e compilar o repositório na B — rejeitada: traz o Model Plane, o
agentd e todas as dependências. (2) Publicar o pacote no registro do npm — rejeitada por ora:
o projeto é privado. (3) Pacote local `azigate-client`, gerado na A — escolhida.

**Decisão.** `npm run pack:client` gera `azigate-client-<versão>.tgz` com `azigate-workspace` e
`azigate-agent` em arquivo único (esbuild, `ws` embutido, sem dependências), instalável com
`npm install -g`. `npm run -s client:setup` gera na A o bloco de shell que cria
`~/.config/azigate` (0700, arquivos 0600) na B; os dois programas leem essa pasta sem flags.

**Trade-offs.** O bloco transporta o token do Workspace Server e, com `--with-agent-key`, a chave
do agentd: deve ir direto ao terminal da B. O `.tgz` precisa ser gerado de novo a cada versão.
esbuild entra como devDependency fixa (já era dependência transitiva de `tsx` e `vitest`).

**Consequências.** A suíte comum `test/workspace-compat.test.ts` roda com o pacote empacotado e
configurado pelo bloco do `client:setup` — exatamente o fluxo da B. Documentação em
[client-package.md](../docs/modules/workspace/client-package.md).
