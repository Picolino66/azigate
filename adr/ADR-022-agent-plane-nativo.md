# ADR-022 — Agent Plane nativo, stateful e separado do Model Plane

- Status: aceito
- Fase: F2 (evolução arquitetural, ciclo `native-agent-plane`)
- Data: 25/09/2026
- Origem: `v2.md` (especificação "Azigate Native Agent Gateway" fornecida pelo operador, fora do versionamento)
- Relaciona-se com: ADR-001 (gateway stateless sem persistência, restringido ao Model Plane), ADR-006
  (agente cliente como único executor, restringido ao Model Plane), ADR-016 (fim do
  broker de subprocessos no Model Plane), ADR-023, ADR-024

## Contexto

O azigate é um **Model Gateway**: recebe `POST /v1/chat/completions`, escolhe um provedor
pelo `model` e devolve texto/tool calls. Quem executa ferramentas é sempre o agente
cliente (ADR-006). Esse desenho é stateless e continua útil para Qwen Code, Cline,
Continue e afins.

O `v2.md` pede outra capacidade: usar Codex, Claude Code e Google Antigravity CLI (AGY)
como **agentes completos**, com sessão, contexto, ferramentas, permissões, subagentes,
MCP e cancelamento próprios. Esses agentes não são endpoints de modelo. Convertê-los para
Chat Completions repetiria o problema que motivou o ADR-016: a tradução apaga a
semântica nativa (sessão, aprovação, subagente) e fica refém de heurísticas.

Evidência coletada nas CLIs instaladas no host (25/09/2026), sem chamada de modelo:

| CLI | Versão | Interface programática verificada |
|---|---|---|
| Codex | `codex-cli 0.144.6` | `codex app-server` (JSON-RPC por stdio, sem campo `jsonrpc`); `initialize` respondeu; schema oficial gerado por `codex app-server generate-json-schema` contém `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, `model/list` e as requisições de aprovação |
| Claude Code | `2.1.280` | `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio`; `control_request` `initialize` respondeu `control_response` |
| AGY | `1.2.10` | `agy --input-format stream-json --output-format stream-json`; emite `{"event":"init","conversation_id":…}` e `{"event":"result",…}`; a entrada exige `{"event":"user","message":{"role":"user","content":…}}` e rejeita `control_request` ("not supported yet") |

## Alternativas consideradas

1. **Traduzir os agentes para `/v1/chat/completions`.** Reaproveita a superfície atual,
   mas destrói sessão, aprovações e eventos nativos, e reintroduz a tradução via modelo
   eliminada pelo ADR-016. Rejeitada.
2. **Adicionar rotas de agente ao processo atual (`azigate`).** Menos processos para
   operar, porém mistura um serviço stateless containerizado com processos vivos,
   credenciais das CLIs, banco e workspaces; um crash de CLI ou vazamento de memória
   afetaria o Model Plane. Rejeitada.
3. **Processo separado `azigate-agentd` com protocolos nativos (escolhida).** O Model
   Plane permanece exatamente como está; o Agent Plane ganha lifecycle, limites,
   credenciais e deploy próprios.

## Decisão

1. **Dois planos lógicos, dois processos.** `azigate` (Model Plane) mantém as quatro rotas
   públicas, stateless, sem subprocesso. `azigate-agentd` (Agent Plane) é um novo
   entrypoint (`dist/agentd/server.js`) com porta, credenciais, limites e persistência
   próprios. Nenhum módulo do Model Plane importa código do Agent Plane.
2. **Protocolo natural de cada fornecedor.** Codex via `codex app-server` (JSON-RPC por
   stdio); Claude Code via `claude -p` em `stream-json` bidirecional com o protocolo de
   controle (`control_request`/`control_response`); AGY via `stream-json` headless.
   Nenhum evento de agente é convertido para `chat.completion.chunk`.
3. **Abstração por sessão, turno, evento, ferramenta e aprovação.** A interface interna
   `AgentProvider` não conhece `messages`, `choices` nem `tool_calls`. Cada provedor
   emite eventos universais mínimos (`session.started`, `turn.started`, `message.delta`,
   `reasoning.delta`, `tool.started`, `tool.completed`, `approval.required`,
   `approval.resolved`, `subagent.started`, `subagent.completed`, `usage`,
   `turn.completed`, `turn.failed`, `session.closed`, `provider.event`) e **sempre**
   anexa o evento original em `native`. Evento nativo sem mapeamento vira
   `provider.event`, nunca é descartado.
4. **Autenticação delegada às CLIs oficiais.** O Agent Plane nunca lê, copia, renova ou
   armazena credenciais Codex, Claude ou Google. Ele apenas inicia a CLI com `HOME`
   do operador e ambiente mínimo; login e refresh são responsabilidade de cada CLI.
   O OAuth próprio do Model Plane (ADR-018) não é reutilizado aqui.
5. **Credenciais separadas.** O Agent Plane aceita somente `AGENT_API_KEYS`; a
   inicialização falha se alguma chave coincidir com `GATEWAY_API_KEYS`. Workers usam
   um terceiro tipo de credencial (ADR-023).
6. **Workspaces por identificador.** O cliente informa `workspace` (e opcionalmente
   `worker`), nunca `cwd` ou path. Workspaces locais do host A vêm de
   `AGENT_WORKSPACES_FILE`, configurado pelo operador; workspaces remotos, do worker
   (ADR-023).
7. **Permissões nunca desligadas.** Modos públicos fechados: `review` (padrão),
   `acceptEdits` e `plan`. Nenhum caminho usa `--dangerously-skip-permissions`,
   `bypassPermissions`, `danger-full-access` ou `approvalPolicy: never`.
8. **Aprovação é entidade de primeira classe.** Pedidos de permissão do Claude
   (`can_use_tool`) e do Codex (`item/commandExecution/requestApproval`,
   `item/fileChange/requestApproval`, `item/permissions/requestApproval` e legados)
   viram `approval.required` com `approvalId`; `POST /agent/v1/approvals/:id` decide
   `allow`/`deny`; expiração (`AGENT_APPROVAL_TIMEOUT`) nega. O AGY headless não expõe
   canal de aprovação: ações que exigiriam revisão são negadas pela própria CLI e
   aparecem como eventos nativos.
9. **Endpoints nativos somente de saída.** `WS /native/:provider/:sessionId` transmite os
   payloads nativos da sessão. Mensagens do cliente não são repassadas à CLI: o
   app-server do Codex expõe `command/exec`, `fs/writeFile`, `config/value/write` e
   `account/logout`, e aceitar JSON-RPC arbitrário equivaleria a execução remota no
   host A.
10. **Subprocessos controlados.** `spawn` sem shell, argv montado em código a partir de
    valores validados (modelo e effort não podem começar com `-`), ambiente mínimo por
    allowlist, grupo de processos próprio, término escalonado (`SIGINT` → `SIGTERM` →
    `SIGKILL`), limite de linha NDJSON, timeout de turno e de ociosidade, limite global e
    por provedor de sessões com processo vivo.
11. **Versões certificadas.** Cada sessão registra `providerVersion`, `adapterVersion` e
    `protocolVersion`. O startup executa `<binário> --version`; versão fora da matriz
    certificada gera aviso (`AGENT_VERSION_POLICY=warn`) ou desabilita o provedor
    (`fail-closed`, padrão em produção).
12. **Aliases legados preservados.** `codex-cli-*` e `claude-cli-*` continuam no Model
    Plane e passam a ser documentados como **model adapters**. Os agent providers são
    `codex`, `claude` e `agy` (aceitos também como `codex-agent`, `claude-agent` e
    `agy-agent`).

## Trade-offs

- Um segundo serviço aumenta a superfície operacional (porta, unidade, backup do banco),
  em troca de isolamento de falhas e de ciclo de vida entre os planos.
- Protocolos nativos evoluem rápido (dois deles se declaram experimentais). A matriz
  certificada e os contract tests por fixture tornam a quebra visível, mas cada upgrade
  de CLI exige revalidação.
- Eventos universais são deliberadamente mínimos; clientes que precisam de fidelidade
  total leem `native`.
- O AGY headless sem canal de aprovação limita o modo `review` a "negar o que exigiria
  revisão".

## Consequências

- ADR-006 passa a valer **somente para o Model Plane**. No Agent Plane o executor é o
  agente nativo, confinado ao workspace escolhido por ID e às permissões do modo.
- ADR-001 (gateway stateless, sem persistência) passa a valer somente para o Model Plane; o Agent Plane tem
  persistência mínima (ADR-024).
- As invariantes do `CLAUDE.md`/`AGENTS.md` foram reescritas por plano.
- Contrato novo em [`specs/agent-api.md`](../specs/agent-api.md) e
  [`specs/agent-openapi.yaml`](../specs/agent-openapi.yaml); documentação em
  [`docs/modules/agents/`](../docs/modules/agents/index.md).

## Adendo (25/09/2026, mesmo ciclo)

O AGY se atualizou automaticamente de 1.2.10 para 1.2.11 durante a implementação. A
verificação de versão o marcou como não certificado, como previsto na decisão 11. As
sondagens sem cota foram repetidas (formato de `init`/`result`, entrada `event: user`,
recusa de `control_request`, conversa inexistente criando conversa nova) com resultado
idêntico, e a 1.2.11 entrou na matriz com fixture própria. "Certificado" significa
protocolo verificado contra o binário real; a suíte `test:agents:real` continua como gate
manual antes de produção.

