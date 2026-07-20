# ADR-012 — Configuração Claude em home efêmero

## Status

Aceita em 20/07/2026. Complementa os ADR-005, ADR-006 e ADR-010 sem alterar o protocolo privado v5.

## Contexto

O Claude Code autenticado usa o diretório `~/.claude` e também o arquivo separado `~/.claude.json`. O systemd ocultava o home com `ProtectHome=tmpfs` e reexpunha somente `~/.claude`; o Bubblewrap criava `/home/agent` e montava apenas `/home/agent/.claude`. O startup aprovava `claude auth status`, mas uma inferência real encerrava com código 1 porque `/home/agent/.claude.json` não existia.

## Alternativas consideradas

1. Expor o home inteiro: simples, mas viola o menor privilégio e amplia acesso a repositórios, configurações e secrets.
2. Montar `~/.claude.json` original como gravável no Bubblewrap: funcional, mas permite que o subprocesso altere o estado persistente do host.
3. Expor o arquivo original somente leitura ao broker e entregar ao Claude uma cópia por execução em um home descartável.

## Decisão

- Introduzir `CLAUDE_CONFIG_PATH`, com default `~/.claude.json`, apenas na configuração privada do broker.
- Exigir arquivo regular de até 1 MiB, pertencente ao UID do broker, legível e sem permissões para grupo/outros; falha retorna capacidade `config_file_unavailable`.
- Reexpor o arquivo ao serviço systemd por `BindReadOnlyPaths`, mantendo `ProtectHome=tmpfs`.
- Copiar o arquivo validado para um home efêmero `0700`, com cópia `0600`, dentro do workspace privado de cada execução.
- Montar esse home descartável em `/home/agent` e sobrepor somente o auth dir `~/.claude` em `/home/agent/.claude`.
- Nunca incluir o path de configuração no protocolo público/privado, no argv do CLI ou nos logs.
- Remover a cópia no mesmo `finally` que apaga o workspace, inclusive em erro, timeout e cancelamento.

## Trade-offs

Cada execução Claude faz uma cópia local pequena. Mudanças que o CLI fizer em `.claude.json` durante a chamada são descartadas, enquanto atualizações necessárias no diretório autenticado `.claude` continuam persistentes. Em troca, o arquivo original e o restante do home não ficam graváveis nem visíveis ao subprocesso.

## Consequências

- Broker e unidade systemd precisam ser atualizados juntos.
- O gateway/container não precisa mudar porque o protocolo permanece v5.
- O health deixa de produzir falso positivo quando o arquivo falta ou está exposto por permissões inseguras.
- O smoke real deve distinguir falha de isolamento de rejeição externa da conta, como `429`.
