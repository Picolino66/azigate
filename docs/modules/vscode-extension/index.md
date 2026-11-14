# Extensão VS Code (máquina B)

Painel **Azigate** na barra lateral do VS Code da máquina do projeto (B). Pelo painel, o
desenvolvedor conversa com Claude Code, Codex ou AGY, que rodam no `azigate-agentd` (máquina A)
e operam o projeto aberto pelo Workspace Server, sem copiar nada para A. É um cliente da
[Agent API](../../../specs/agent-api.md), equivalente ao [`azigate-agent`](../agents/agent-client.md)
de terminal. Decisão no [ADR-028](../../../adr/ADR-028-extensao-vscode-maquina-b.md).

```text
VS Code (máquina B)
├── painel Azigate (webview) ──postMessage──► host da extensão
│                                              ├── HTTPS ──► azigate-agentd /agent/v1/* (máquina A)
│                                              └── spawn ──► azigate-workspace ──WSS de saída──► agentd
└── projeto aberto ◄── MCP (ferramentas azigate_workspace) ◄── Claude/Codex/AGY na máquina A
```

## Features

- [Painel de agentes](./chat-panel.md): sessão, streaming, ferramentas, aprovações e cancelamento.
- [Conexão e workspaces](./connection.md): URL e chave do agentd, e escolha do workspace por ID.
- [Workspace Server local](./workspace-server.md): iniciar e parar o `azigate-workspace` pelo editor.
- [Empacotamento e instalação](./packaging.md): `npm run pack:vscode` e "Install from VSIX…".

## Localização no código

`src/vscode-extension/` (`extension.ts`, `session-controller.ts`, `protocol.ts`,
`connection.ts`, `workspace-process.ts`, `webview.ts`), `tools/vscode-package.ts`,
`tools/build-vscode.ts` e `test/vscode-extension.test.ts`.

## Regras do módulo

- Só `extension.ts` importa `vscode`. O resto é testado no Vitest sem o editor.
- O módulo segue a fronteira do Agent Plane (`no-restricted-imports`): nunca importa o Model
  Plane, e o Model Plane nunca o importa.
- Mesmas invariantes do `azigate-agent`: workspace e worker só por ID, aprovação só com `allow`
  explícito, e nenhum prompt, resposta ou argumento de ferramenta gravado em log.
