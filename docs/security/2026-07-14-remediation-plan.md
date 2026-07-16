# Plano de correção

| Campo | Valor |
|---|---|
| Projeto | deepseek-gateway |
| Data | 14/07/2026 |
| Responsável | mantenedor do gateway |
| Relatório | [2026-07-14-security-review.md](./2026-07-14-security-review.md) |

## Ordem de correção

1. SEC-003 — smoke/TLS/SSE no domínio real antes de liberar tráfego.
2. SEC-001 — adicionar scanners pinados ao pipeline e escanear histórico Git.
3. SEC-002 — adotar estado compartilhado somente antes de escalar réplicas.

## Achados bloqueantes

Não há achado Critical ou High. A publicação operacional continua condicionada ao checklist SEC-003, porque este ambiente não possui o domínio/certificado reais.

## Quick wins

| ID | Severidade | Ação | Esforço | Status |
|---|---|---|---|---|
| SEC-003 | Info | validar TLS, headers, modelos, chat e `curl -N` no domínio | S | pendente de deploy |
| SEC-001 | Low | integrar Gitleaks e Trivy pinados no CI | S | pendente |

## Correção estrutural

| ID | Severidade | Ação | Esforço | Dependência | Status |
|---|---|---|---|---|---|
| SEC-002 | Info | mover cache/rate limit para backend compartilhado | M | decisão de escala e ADR | não necessária para uma instância |

## Testes de regressão

| Achado | Teste | Tipo | Aprovação |
|---|---|---|---|
| SEC-001 | scans do working tree, histórico, dependências e imagem | CI | zero Critical/High sem mitigação e zero secret real |
| SEC-002 | limite agregado entre duas réplicas | integração | mesmo teto independentemente da réplica |
| SEC-003 | curls do README, TLS e cancelamento | smoke manual | status esperados, SSE progressivo e socket upstream fechado |

## Comandos de validação

```bash
npm run check
npm run test:coverage
npm audit --omit=dev --audit-level=high
docker build -t deepseek-gateway:validation .
DEEPSEEK_API_KEY=dummy GATEWAY_API_KEYS=dummy docker compose config --quiet
# Quando as ferramentas forem instaladas pela equipe:
gitleaks detect --source . --redact
trivy image deepseek-gateway:validation
```

## Status

| Achado | Ação | Status |
|---|---|---|
| SEC-001 | scanners avançados | pendente, risco baixo |
| SEC-002 | estado compartilhado | condicionado à escala |
| SEC-003 | validação pós-deploy | pendente de infraestrutura externa |
