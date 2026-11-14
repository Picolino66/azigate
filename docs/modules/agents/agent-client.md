# Cliente de terminal `azigate-agent`

## Descrição

Chat de terminal sobre a Agent API, pensado para a máquina B: cria a sessão, mostra o
streaming, as ferramentas e as aprovações, e permite trocar só o agente mantendo o mesmo
workspace da máquina B.

```text
$ azigate-agent chat claude meu-projeto
provider: claude
agent host: 127.0.0.1:3100
workspace host: maquina-b
workspace: meu-projeto

> analise o projeto e rode os testes

Claude:
Vou analisar a estrutura.
  ▸ READ package.json
  ▸ RUN npm test
  ⚠ Aprovar RUN npm test? [y/N] y
  ✓ aprovado
```

Há um cliente equivalente para o editor: a [extensão VS Code](../vscode-extension/index.md).

## Localização no código

`src/agent-client/main.ts` (entrypoint; `azigate-agent` do
[pacote da máquina B](../workspace/client-package.md) ou `npm run agent --`), `args.ts`,
`api.ts` (HTTP/SSE), `chat.ts` (`ChatController`), `render.ts`, `settings.ts` (URL e chave).

## Entrada

`azigate-agent chat <claude|codex|agy> <workspace> [--worker id] [--local] [--model m]
[--effort e] [--mode review|acceptEdits|plan] [--resume agt_…] [--keep] [--reasoning]`,
`azigate-agent providers`, `azigate-agent workers`. URL: `AZIGATE_AGENT_URL` → `agent.json` da
pasta local → `http://127.0.0.1:3100`. Chave: `AZIGATE_AGENT_KEY_FILE` → `AZIGATE_AGENT_KEY` →
`agent.key` da pasta local. Arquivos de chave precisam ser `0600`.

## Saída

Texto do agente, `▸ READ/WRITE/EDIT/RUN/GIT …` por ferramenta, `⚠ Aprovar …? [y/N]`,
falhas de ferramenta, uso de tokens ao fim do turno.

## Dependências

Agent API do `azigate-agentd`.

## Regras de negócio

- Sem `--worker`, descobre o Workspace Server que expõe o workspace; mais de um exige
  `--worker`; nenhum é erro (use `--local` para um workspace da máquina A).
- Aprovação: só `y`/`s`/`sim`/`yes` aprova; qualquer outra resposta nega.
- Ctrl+C durante um turno cancela; de novo, sai. `/cancelar` e `/sair` no prompt.
- Ao sair, encerra a sessão, exceto com `--keep` (retome com `--resume`).

## Fluxo resumido

workers → criar sessão → SSE → prompt → `POST turns` → eventos/aprovações até
`turn.completed|failed` → próximo prompt → `DELETE` ao sair.

## Possíveis erros

`invalid_agent_key`, `worker_unavailable`, `workspace_not_found`, `provider_unavailable`,
`agent_start_failed` (mostrados como `erro: <código>: <mensagem>`).
