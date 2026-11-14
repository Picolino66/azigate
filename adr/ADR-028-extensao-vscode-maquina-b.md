# ADR-028 — Extensão VS Code como cliente do Native Agent Plane na máquina B

- Status: aceito
- Fase: F2–F5 (feature-evolution)
- Data: 13/11/2026
- Relaciona-se com: ADR-022, ADR-023, ADR-025 (Workspace Server e `azigate-agent`)

## Contexto

Na máquina do projeto (B), o operador conversa com Claude Code, Codex e AGY, que rodam no
`azigate-agentd` (máquina A), por meio do `azigate-agent`, um chat de terminal. Quem programa
na B passa o dia no VS Code e pediu para usar os agentes de dentro do editor, sem um terminal à
parte e sem iniciar o `azigate-workspace` à mão.

A Agent API (`/agent/v1/*`) já é um contrato HTTP + SSE completo e independente de cliente. O
`azigate-agent` tem cerca de 570 linhas, e o cliente HTTP (`src/agent-client/api.ts`) não
depende de terminal.

## Alternativas consideradas

Para a interface:

1. **Chat Participant API do VS Code (`@azigate` no chat nativo).** Usa a interface de chat do
   editor, mas ela só existe com o GitHub Copilot Chat instalado e logado. Também é difícil
   mostrar aprovações persistentes por turno.
2. **WebviewView na barra lateral** (escolhida). Funciona sem nenhuma outra extensão, permite
   cards de aprovação com botões e usa as variáveis de tema do editor.
3. **Pseudoterminal rodando o `azigate-agent`.** É barato, mas não melhora nada em relação ao
   terminal.

Para o empacotamento:

1. **`@vscode/vsce`.** É a ferramenta oficial, mas traz dezenas de dependências transitivas para
   o `package-lock.json` e para o `npm audit`.
2. **Bundle esbuild + `.vsix` montado por script próprio** (escolhida). O esbuild já é
   devDependency. Um `.vsix` é um ZIP com `extension.vsixmanifest` e `[Content_Types].xml`.
   Basta um writer ZIP sem compressão de cerca de 60 linhas.

Para o local do código:

1. **Repositório separado.** Duplicaria o cliente da Agent API e os tipos de evento.
2. **`src/vscode-extension/` no monorepo** (escolhida), reaproveitando `agent-client/api.ts`,
   `render.ts`, `settings.ts` e `agent-control/workspaces.ts`, sob as mesmas regras de lint de
   fronteira do Agent Plane.

## Decisão

- Criar `src/vscode-extension/`. O núcleo (`session-controller.ts`, `protocol.ts`,
  `connection.ts`, `workspace-process.ts` e `webview.ts`) não importa `vscode` e é testado no
  Vitest. Só `extension.ts` liga a API do editor.
- A extensão é um **cliente** da Agent API, como o `azigate-agent`. Não há mudança de contrato no
  agentd. Ela escolhe agente e workspace **só por ID**, descobre o Workspace Server pelo
  `GET /agent/v1/workers` e nunca envia caminho, comando, argv, ambiente ou URL ao agentd.
- Aprovação só vale com clique explícito em **Permitir**, no card do painel ou na notificação
  mostrada quando o painel está oculto. Fechar a notificação não decide nada, e o agentd nega ao
  expirar.
- O webview é origem não confiável. Cada mensagem passa por `parseInboundMessage` (lista fechada
  de tipos e IDs com padrão restrito). A CSP é `default-src 'none'`, com script e estilo só por
  nonce, e todo texto do agente entra por `textContent`.
- A chave do agentd fica no **SecretStorage** do VS Code (comando "Definir chave do agentd") ou
  continua no `agent.key` `0600`. Com a chave no SecretStorage, o arquivo nem é lido. A chave
  nunca vai para as configurações.
- A URL do agentd precisa ser `https://`. `http://` só é aceito em loopback (túnel SSH), na mesma
  regra do `wss://` do Workspace Server.
- A extensão pode iniciar e parar o `azigate-workspace` local: `spawn` sem shell e sem argumentos,
  ambiente mínimo por allowlist, grupo de processos, SIGTERM e depois SIGKILL em 5 s. O comando
  configurável aceita só um nome de programa ou um caminho absoluto, nada começando com `-`.
- As configurações `azigate.*` têm escopo `machine`: um `.vscode/settings.json` de um repositório
  não pode trocar a URL do agentd nem o programa iniciado. A extensão declara
  `untrustedWorkspaces.supported: false` e `extensionKind: ["workspace"]`, para rodar onde está o
  projeto, inclusive em Remote-SSH.
- O pacote sai por `npm run pack:vscode` em `dist-vscode/azigate-vscode-<versão>.vsix` e contém
  só o bundle da extensão. Nada do Model Plane nem do agentd entra nele, e um teste de regressão
  verifica isso.

## Trade-offs

- O WebviewView exige manter HTML, CSS e JS próprios, em vez de usar a interface de chat
  nativa.
- O `.vsix` montado à mão não passa pelas validações do `vsce`. A validação passou a ser
  instalar o pacote no VS Code numa pasta de extensões isolada.
- A extensão não é publicada no Marketplace (`private`, publisher `azigate`). A instalação é por
  "Install from VSIX…".
- A sessão é encerrada ao fechar o editor. Retomar uma sessão (`--resume` do CLI) não faz parte
  desta versão.

## Consequências

- Nova fronteira de confiança na máquina B (webview ↔ host da extensão ↔ agentd), registrada no
  threat model.
- `@types/vscode` 1.100.0 entra como devDependency fixada (sem dependências transitivas). O
  `engines.vscode` é `^1.100.0`.
- Mudanças na Agent API passam a ter dois clientes para atualizar: `azigate-agent` e a extensão.
