# Módulo Workspace Server

O **Workspace Server** (`azigate-workspace`, antigo `azigate-worker`) roda na máquina do
projeto (máquina B). É um componente pequeno e neutro: **não é um agente, não chama modelo e
não decide nada**. Ele só expõe as capacidades do ambiente — arquivos, busca, Git, processos —
por **MCP**, para qualquer agente que fale MCP
([ADR-025](../../../adr/ADR-025-workspace-server-mcp-para-os-tres-agentes.md)).

```text
                       Workspace Server (máquina B)
Claude Code (A) ──MCP──►│
Codex (A) ─────MCP─────►│  arquivos · busca · git · processos · testes → projeto
AGY (A) ───────MCP─────►│
cliente MCP local (B) ─►│  (--mcp-stdio)
```

Ele não depende do Model Plane nem de nenhum agente específico: o mesmo processo atende Claude,
Codex e AGY. Qwen Code, Cline ou outro agente continuam usando o Model Plane normalmente; se um
dia quiserem usar o workspace via MCP, basta o modo `--mcp-stdio`.

## Features

- [Servidor e conexão](./server.md) — configuração, modos, registro e reconexão.
- [Servidor MCP do workspace](./mcp.md) — ferramentas, anotações e canais.
- [Segurança do workspace](./security.md) — jail, `.git`, Git endurecido, execução e token.
- [Pacote da máquina B e `client:setup`](./client-package.md) — instalação sem o repositório e configuração em um passo.

## Código

| Pasta | Responsabilidade |
|---|---|
| `src/workspace/server/` | entrypoint, configuração, conexão de saída e despacho |
| `src/workspace/mcp/` | servidor MCP das ferramentas do workspace |
| `src/workspace/filesystem/` | operações de arquivo |
| `src/workspace/process/` | execução por argv e processos longos |
| `src/workspace/git/` | Git endurecido |
| `src/workspace/security/` | jail de caminhos, token de worker e arquivos locais privados |
| `src/workspace/protocol/` | mensagens, esquemas das ferramentas e transporte |

Contrato: [workspace-protocol.md](../../../specs/workspace-protocol.md).
