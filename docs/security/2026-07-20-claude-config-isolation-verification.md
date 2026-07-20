# Verificação defensiva: configuração Claude na sandbox

## Status

**Corrigido e implantado; smoke funcional bloqueado externamente.** Não há
bloqueio Critical/High. O impedimento atual é operacional: resposta externa
`429` da conta Claude.

## Evidências

| Item | Resultado |
|---|---|
| Causa original | confirmada: `/home/agent/.claude.json` ausente |
| Arquivo do host | regular, `0600`, owner igual ao UID do broker |
| Exposição systemd | somente leitura e path específico |
| Exposição Bubblewrap | cópia efêmera, nunca o path original |
| Home completo | continua oculto |
| Arquivo original | preservado mesmo quando a cópia é modificada no teste |
| Logs/argv | sem conteúdo ou path do arquivo original |
| Reprodução real | alcançou a API Claude; resposta `429` externa |
| Gate automatizado | 141/141 testes, cobertura 81,45% statements / 76,30% branches, audit sem vulnerabilidades |
| Broker implantado | v5 ready; Codex e Claude saudáveis nos checks locais |

## Classificação

- Achado funcional de disponibilidade: **Corrigido localmente**.
- Ampliação de privilégio ou exposição do home: **não identificada** nos testes executados.
- Risco residual: o auth dir `.claude` permanece gravável porque a sessão pode precisar atualizar estado; o arquivo `.claude.json` persistente permanece somente leitura para o serviço e ausente do container.

## Plano de validação pós-deploy

1. repetir no Qwen `/effort medium` quando a conta não estiver limitada;
2. confirmar que logs continuam sem prompts, respostas, config ou credenciais;
3. manter o alias fora da allowlist enquanto o diagnóstico retornar `rate_limit`.
