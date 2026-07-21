# Relatório de segurança da evolução multiprovedor

## Cabeçalho

| Campo | Valor |
|---|---|
| Projeto | `azigate` |
| Data | 16/07/2026 |
| Escopo | gateway, broker host, Codex/Claude isolados, Compose, systemd e documentação |
| Auditoria | orquestrador + `defensive-security-auditor` |
| Status | implementação local aprovada; ativação depende de smoke no PC da VPN |

## Resumo executivo

A evolução mantém as quatro rotas públicas e a DeepSeek sem regressão, adicionando uma fronteira Unix privada para CLIs agentivas. Não foi encontrada vulnerabilidade Critical, High ou Medium confirmada. Os controles mais importantes possuem implementação e evidência: aliases sem fallback, protocolo sem campos de execução, socket `0600`, auth dirs `0700`, `spawn` sem shell, Bubblewrap sem repositório/home, ambiente limpo, output schema, allowlist de tools, concorrência 1, timeout, limite de saída e cancelamento do grupo.

Os gates reais do Codex e Claude passaram, mas isso não autoriza habilitação automática. Codex continua opt-in; Claude permanece segunda fase. O smoke Qwen -> gateway -> tool call -> confirmação -> edição no PC da VPN é a pendência operacional.

| Severidade | Quantidade |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 1 |
| Info | 2 |

## Evidências executadas

| Gate | Resultado |
|---|---|
| `npm run check` | lint, typecheck, 95 testes e build aprovados |
| `npm run test:coverage` | 80,50% statements; 74,39% branches; 86,02% functions; 85,96% lines |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilidades |
| gate Codex real | 20/20 estruturais, 0 ferramentas locais, 20/20 categorias |
| gate Claude real | 20/20 estruturais, 0 ferramentas locais, 20/20 categorias |
| Bubblewrap/Unix | smoke real aprovado; DNS usa bind do `resolv.conf` resolvido e `/etc` completo fica ausente |
| `docker compose config --quiet` | aprovado com secrets fictícios |
| `systemd-analyze verify` | unidade aprovada; aviso do `getty` do host é externo ao projeto |
| `docker build -t azigate:validation .` | aprovado |
| smoke do container/Compose | `/health`, usuário não root e modo DeepSeek-only sem broker aprovados |

Testes automatizados usam upstream, broker e executáveis falsos; somente os dois gates de viabilidade explicitamente invocados consumiram os CLIs reais. Os relatórios dos gates contêm apenas contagens, sem prompts, respostas ou dados de autenticação.

## Controles validados

- `src/providers/registry.ts`: aliases reservados e ausência de fallback.
- `src/providers/cli-request.ts`: reconstrução textual/function tool e validação da decisão.
- `src/broker/protocol-validation.ts`: shape exato, sem cwd/comando/URL/env.
- `src/broker/process-runner.ts`: `shell: false`, grupos, timeout, cancelamento e output limit.
- `src/broker/isolation.ts`: Bubblewrap, ambiente mínimo e filesystem descartável.
- `src/broker/executor.ts`: argv fixo, inspeção de eventos e schema final fail-closed.
- `src/broker/server.ts`: socket privado, concorrência global 1 e health sanitizado.
- `docker-compose.yml`: somente o diretório do socket é montado no container, como read-only.
- `config/systemd/azigate-broker@.service`: hardening, limites, home oculto e reexposição somente de auth/binário necessários.

## Achados

### SEC-MP-001 — Smoke ponta a ponta no PC da VPN pendente

| Campo | Valor |
|---|---|
| Severidade | Low |
| Prioridade | P2 antes de ativar o alias |
| Status | pendente de ambiente externo |

O ambiente local comprovou protocolo, isolamento, gates reais e container, mas não tem acesso ao Qwen/repositório descartável do PC da VPN. Antes de habilitar para uso normal, validar leitura, busca, edição confirmada, shell confirmado, retorno de tool, cancelamento e troca DeepSeek/Codex. A evidência deve confirmar que nenhum arquivo aparece no servidor.

### SEC-MP-002 — Scanners adicionais de supply chain indisponíveis

| Campo | Valor |
|---|---|
| Severidade | Info |
| Prioridade | P3 |
| Status | recomendação |

`npm audit`, lockfile e build passaram. Gitleaks, Trivy/Semgrep/Docker Scout não fazem parte do ambiente atual; não foram instalados automaticamente. Integrá-los ao CI aumenta a defesa em profundidade.

### SEC-MP-003 — Dependência operacional de CLI/kernel

| Campo | Valor |
|---|---|
| Severidade | Info |
| Prioridade | contínua |
| Status | risco aceito no escopo single-user |

O isolamento depende dos flags das versões instaladas, Bubblewrap, user namespaces e login existente. Checks de startup e gates evitam publicação silenciosa, mas cada atualização de CLI/host exige repetição dos gates.

## Conclusão

O artefato local está apto a um deploy controlado com aliases inicialmente desabilitados. A DeepSeek pode permanecer ativa independentemente do broker. Publicar `codex-cli` requer o smoke SEC-MP-001; `claude-cli` requer o mesmo smoke em sua segunda fase e revisão da política operacional do login existente.
