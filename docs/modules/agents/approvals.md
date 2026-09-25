# Aprovações

## Descrição

Pedidos de permissão emitidos pela CLI viram uma entidade do Azigate com ID próprio,
decidida pelo cliente por HTTP. O Azigate nunca liga modos que pulam permissões.

## Localização no código

- `src/agent-control/approvals.ts` — `ApprovalService`.
- `src/agents/claude/claude-session.ts` — `can_use_tool` e `control_cancel_request`.
- `src/agents/codex/codex-events.ts` — `codexApprovalRequest`.
- `src/agentd/routes/sessions.ts` — `POST /agent/v1/approvals/:id`.

## Entrada

`{ "decision": "allow" | "deny" }`.

## Saída

Objeto da aprovação (`pending`, `allowed`, `denied`, `expired`, `cancelled`) e os
eventos `approval.required`/`approval.resolved`.

## Dependências

`SessionService` (cria a aprovação pelo contexto da sessão) e os providers.

## Regras de negócio

- Qualquer desfecho diferente de `allow` explícito nega: expiração
  (`AGENT_APPROVAL_TIMEOUT`), cancelamento do turno, desistência do próprio agente,
  fechamento da sessão ou reinício do agentd.
- A aprovação pertence à credencial dona da sessão; outra credencial recebe `404`.
- Decidir duas vezes responde `409 approval_already_resolved`.
- `summary` é o comando, arquivo ou argv pedido, truncado em 500 caracteres; aparece só
  para o dono, nunca em log.
- Mapeamento nativo em [agent-api.md](../../../specs/agent-api.md#aprovações). O AGY
  headless não tem canal: ações que exigiriam revisão são negadas pela própria CLI.
- Em sessões Claude com worker, as ferramentas somente leitura já vêm liberadas por
  `--allowedTools`; escrita e execução passam por aqui.

## Fluxo resumido

CLI pede permissão → provider chama `context.requestApproval` → `approval.required` →
cliente decide → `approval.resolved` → provider responde à CLI (`allow`/`accept`/
`approved` ou `deny`/`decline`/`denied`).

## Possíveis erros

`400 invalid_decision`, `404 approval_not_found`, `409 approval_already_resolved`.
