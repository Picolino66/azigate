# Incidente: configuração Claude ausente na sandbox

## Resumo

Em 20/07/2026, chamadas a `claude-cli-opus-4.8` passaram pela autenticação, roteamento e normalização de effort, mas retornaram `502 cli_execution_failed` em aproximadamente dois segundos. DeepSeek, Codex, `/health` e `/ready` permaneceram disponíveis. Severidade operacional: P2.

## Impacto

Somente inferências Claude falharam. Nenhum repositório, prompt, credencial ou arquivo do computador da VPN foi exposto ou alterado pelo broker.

## Linha do tempo

- 10:42 BRT: broker e gateway v5 reiniciados com health saudável.
- 10:44 BRT: Qwen iniciou chamadas Claude com effort `medium`; o gateway retornou `502`.
- 10:46 BRT: reprodução sintética identificou ausência de `/home/agent/.claude.json`.
- 10:58 BRT: correção local passou nos testes focados; smoke alcançou a API Claude e recebeu `429` externo.

## Causa raiz

O Claude Code depende de dois artefatos separados: `~/.claude` e `~/.claude.json`. A unidade systemd e o Bubblewrap expunham somente o primeiro. O check de capacidade usava `claude auth status`, que não detectava a dependência exigida pela inferência real.

## Correção

A [ADR-012](../../../adr/ADR-012-configuracao-claude-em-home-efemero.md) define validação fail-closed do arquivo, bind somente leitura para o broker e cópia por execução em home efêmero. O original nunca entra como gravável na sandbox e o home completo continua oculto.

## Verificação e pendências

- Testes automatizados comprovam cópia `0600`, descarte do workspace, preservação do original e ausência do path real no argv.
- `npm run check` aprovou 141/141 testes; cobertura e audit também passaram.
- Um broker v5 efêmero iniciado diretamente do novo `dist` publicou
  `claude.available=true`, com diretório `0700` e socket `0600`.
- O smoke real deixou de falhar por configuração e alcançou o provider.
- A conta respondeu `429`; o smoke funcional completo depende de liberação de cota/rate limit.
- O operador instalou o `dist` e a unidade corrigidos às 11:11 BRT. O socket v5
  permaneceu `ready` com Claude saudável; a execução deixou de apresentar erro de
  configuração e passou a retornar somente o `429 rate_limit` externo já isolado.

## Prevenção

O health agora omite Claude com `config_file_unavailable` quando o arquivo não existe, não é privado, excede o limite ou pertence a outro UID. Upgrades do Claude Code continuam exigindo gate real.
