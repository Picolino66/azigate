# Relatório de segurança

## 1. Cabeçalho

| Campo | Valor |
|---|---|
| Projeto | deepseek-gateway |
| Repositório / Branch | diretório local sem metadados Git |
| Data da auditoria | 14/07/2026 |
| Auditor | Orquestrador + `defensive-security-auditor` |
| Versão analisada | 1.0.0, working tree local |
| **Status geral** | **OK para build/deploy controlado; validação pós-deploy ainda necessária** |

## 2. Resumo executivo

Foram revisados código, quatro endpoints, autenticação, consumo da DeepSeek, streaming, cancelamento, logs, dependências, Docker, Compose, Nginx e CI. Não foi encontrada vulnerabilidade Critical, High ou Medium confirmada. Os controles de maior risco — troca de credencial, rotas upstream fixas, redirect desabilitado, rate limit, limites de corpo/tempo, logs sem conteúdo e execução não root — possuem código e testes. A liberação pública ainda depende de certificado/domínio reais e smoke tests no ambiente do usuário.

| Severidade | Quantidade |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 1 |
| Info | 2 |

## 3. Escopo analisado

- **Incluído:** `src/`, `test/`, dependências npm, Dockerfile, Compose, Nginx, workflow CI, env example, especificações e README.
- **Excluído:** DeepSeek real, produção, DNS, certificado real, firewall da VPS, histórico Git inexistente e scanners não instalados.
- **Ambiente:** desenvolvimento local autorizado e containers locais descartáveis.
- **Período:** 14/07/2026.

## 4. Metodologia

Revisão estática e testes locais não destrutivos alinhados a OWASP WSTG (autenticação, autorização, input e erros), OWASP ASVS L1, OWASP Top 10 2025, OWASP API Security Top 10 2023, NIST SSDF e controles CIS Docker aplicáveis. O threat model está em [threat-model.md](./threat-model.md), e a matriz completa em [endpoint-inventory.md](./endpoint-inventory.md).

## 5. Stack detectada

| Camada | Tecnologia | Versão | Observações |
|---|---|---|---|
| Runtime | Node.js | >=20.18.1; container 22 Alpine pinado por digest | processo não root |
| Backend | Fastify | 5.10.0 | body limit e rotas deny-by-default |
| HTTP upstream | Undici | 7.28.0 | TLS, Agent, timeouts, abort e redirect error |
| Testes | Vitest | 4.1.10 | mock upstream sem créditos reais |
| Dados | nenhum | N/A | serviço stateless |
| Auth | Bearer próprio | N/A | múltiplas chaves e comparação constante |
| Infra | Docker/Compose/Nginx | local atual | TLS termina no proxy |

## 6. Ferramentas e evidências

| Ferramenta | Status | Resultado |
|---|---|---|
| lint / TypeScript / Vitest | executada | sem erros; 30 testes aprovados |
| cobertura V8 | executada | 86,18% de linhas, 82,56% de statements, 88,88% de funções e 74,30% de branches |
| `npm audit` | executada | 0 vulnerabilidades |
| build TypeScript e Docker | executada | aprovados |
| `docker compose config --quiet` | executada | aprovado com secrets fictícios |
| Nginx oficial `nginx -t` | executada | sintaxe aprovada com certificado descartável |
| varredura regex de secrets | executada | nenhum padrão real encontrado |
| Gitleaks / Trivy / Semgrep / Docker Scout | não disponíveis | não instalados; nenhuma instalação automática foi feita |

Evidências sanitizadas dos scripts da skill ficam em `docs/security/output/` e estão ignoradas pelo Git para evitar versionar logs locais.

## 7. Controles validados

- `src/security/auth.ts`: todos os digests configurados são comparados com `timingSafeEqual`.
- `src/upstream/client.ts`: somente enum interno de paths, Authorization reconstruído e `redirect: error`.
- `src/app.ts`: auth, allowlist de IP e rate limit acontecem antes do parsing do body protegido.
- `Dockerfile`: dependências determinísticas, imagem pinada, healthcheck e `USER node`.
- `docker-compose.yml`: secrets montados, loopback, filesystem read-only, capabilities removidas e limites de recursos.
- `config/nginx/ia.meudominio.com.conf`: TLS 1.2/1.3, headers, rotas fechadas, buffering/cache/gzip/retry desabilitados.

## 8. Achados

### SEC-001 — Cobertura de supply chain local incompleta

| Campo | Valor |
|---|---|
| Severidade | Low |
| Status | RECOMENDAÇÃO |
| Categoria | OWASP A06/A08 |
| Prioridade | P3 |
| Esforço | S |

**Evidência:** `npm audit` e a varredura regex passaram, mas Gitleaks, Trivy, Semgrep e Docker Scout não estão instalados. Além disso, o diretório não contém `.git`, então não foi possível examinar histórico.

**Impacto:** reduz a confiança sobre CVEs da imagem base, misconfigurações detectáveis por scanner e segredos que possam ter existido em commits anteriores.

**Correção:** integrar Gitleaks/Trivy no CI com versões pinadas e executar scan de histórico depois que o projeto estiver em um repositório Git. Não há evidência atual de secret exposto.

**Validação:** pipeline deve falhar em fixture sintética de segredo e em imagem com vulnerabilidade acima do limiar escolhido.

### SEC-002 — Estado local limita escala horizontal

| Campo | Valor |
|---|---|
| Severidade | Info |
| Status | RECOMENDAÇÃO |
| Categoria | OWASP API4 |
| Prioridade | P3 |
| Esforço | M |

Cache e rate limit são por processo. Uma única instância está protegida; réplicas multiplicam efetivamente os limites.

**Correção futura:** usar backend compartilhado somente quando métricas justificarem escala e registrar nova ADR.

### SEC-003 — Controles externos dependem do deploy real

| Campo | Valor |
|---|---|
| Severidade | Info |
| Status | RECOMENDAÇÃO |
| Categoria | OWASP A05 |
| Prioridade | P2 antes da publicação |
| Esforço | S |

Sintaxe Nginx e container foram validados localmente, mas DNS, certificado, firewall, CDN/Traefik e streaming no domínio real não existem neste ambiente.

**Validação:** executar os curls do README, conferir certificado/TLS, headers, progressividade do SSE e cancelamento após o deploy.

## 9. Riscos aceitos

Nenhum risco Critical/High foi aceito. SEC-002 é limitação explícita para uma instância e deve ser reavaliada antes de escala horizontal. SEC-003 impede declarar produção validada, mas não impede entregar o artefato de deploy.

## 10. Checklist final

- [x] Endpoints inventariados e classificados
- [x] Autenticação e autorização verificadas por rota
- [x] Validação de entrada, passthrough e exposição avaliados
- [x] Secrets do working tree verificados e mascarados
- [x] Dependências npm auditadas
- [x] Threat model documentado
- [x] Casos de abuso locais executados
- [x] Achados priorizados com plano de correção
- [x] Status geral definido
- [x] Limitações e riscos residuais registrados
