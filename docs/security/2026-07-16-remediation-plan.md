# Plano de correção da evolução multiprovedor

| Campo | Valor |
|---|---|
| Projeto | `gateway-ai` |
| Data | 16/07/2026 |
| Relatório | [2026-07-16-security-review.md](./2026-07-16-security-review.md) |

## Ordem de tratamento

1. SEC-MP-001: executar o smoke ponta a ponta em repositório descartável antes de habilitar `codex-cli` para uso normal.
2. Repetir SEC-MP-001 para `claude-cli` somente na segunda fase.
3. SEC-MP-002: adicionar scanners pinados ao CI quando a equipe definir a política.
4. SEC-MP-003: repetir capacidade e gates após atualizações de CLI, Bubblewrap, Node ou kernel.

## Critérios do smoke bloqueante

| Cenário | Aprovação |
|---|---|
| texto sem tools | resposta normal sem ação no servidor |
| leitura e busca | Qwen solicita/confirma e executa no PC da VPN |
| edição | somente arquivo descartável do PC da VPN muda |
| shell | confirmação permanece ativa e comando roda no PC da VPN |
| tool result | conversa continua com o resultado retornado pelo Qwen |
| cancelamento | processo CLI termina e a vaga do broker é liberada |
| troca de modelo | DeepSeek e Codex não fazem fallback um para o outro |
| inspeção do servidor | nenhum repositório/cwd do PC remoto aparece no broker |

Use o roteiro em [operação do Qwen Code](../operations/qwen-code.md). Não use YOLO/auto-approval durante a validação.

## Rollback

Se qualquer critério falhar:

1. defina `ENABLE_CODEX_CLI=false` e `ENABLE_CLAUDE_CLI=false`;
2. recrie somente o container do gateway;
3. confirme que `/v1/models` lista apenas DeepSeek;
4. preserve logs sanitizados e repita o gate depois da correção;
5. não substitua o login existente por API key sem nova decisão arquitetural.

## Gates de regressão

```bash
npm run check
npm run test:coverage
npm audit --omit=dev --audit-level=high
docker build -t gateway-ai:validation .
DEEPSEEK_API_KEY=ficticia GATEWAY_API_KEYS=ficticia docker compose config --quiet
systemd-analyze verify config/systemd/gateway-ai-broker@.service
npm run gate:codex
# somente na segunda fase:
npm run gate:claude
```
