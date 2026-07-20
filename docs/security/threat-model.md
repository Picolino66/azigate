# Modelo de ameaças

Data da revisão: 18/07/2026. Escopo: gateway, adaptador de upstream, broker host, subprocessos Codex/Claude, container, Compose, systemd e Nginx. O computador do agente cliente não foi alterado nem testado neste ciclo.

## Ativos

- chave do upstream e chaves Bearer do gateway;
- sessões e diretórios de autenticação `~/.codex` e `~/.claude`;
- prompts, código-fonte, tool arguments, resultados e respostas;
- repositórios no computador do agente cliente;
- disponibilidade e cotas dos provedores.

## Fronteiras de confiança

1. Agente cliente -> Nginx/gateway: rede não confiável, protegida por TLS, Bearer, allowlists e limites.
2. Gateway -> upstream: HTTPS para base e paths fixos, com credencial reconstruída.
3. Container -> broker: protocolo HTTP v4 sobre Unix socket privado; o mount é read-only.
4. Broker -> CLI: processo e saída não confiáveis, contidos por argv fixo, ambiente limpo, Bubblewrap e schema.
5. Agente cliente -> repositório: única fronteira com capacidade de leitura, shell e edição, sujeita à confirmação do usuário.

## Ameaças e controles

| Ameaça | Impacto | Controle implementado | Evidência |
|---|---|---|---|
| Proxy aberto/SSRF | acesso a hosts internos ou terceiros | quatro rotas públicas; registry fechado; base/paths do upstream fixos; broker recusa URL/path | testes de rotas, registry e protocolo |
| Confusão de provedor/fallback | envio de dados ao provedor errado | aliases reservados e sem fallback automático | testes de roteamento e catálogo |
| Roubo/substituição de credencial | uso indevido ou vazamento | Bearer local, comparação constante, Authorization reconstruído e separação container/broker | regressão de auth e mounts do Compose |
| Vazamento do login CLI | controle da conta Codex/Claude | auth dirs `0700`, home oculto por systemd, somente auth/binário necessários reexpostos e auth do provider na sandbox | check de capacidade, systemd e permissões |
| Prompt injection solicitando host/shell | leitura ou alteração do servidor | CLI sem ferramentas, sem repositório/home, `/work` descartável, eventos de execução rejeitados | cenários de gate, testes de argv e output |
| Injeção de comando no broker | execução arbitrária | protocolo não possui comando/cwd/argv/env; `spawn` com `shell: false` e argv fixo | testes de protocolo e fake runner |
| Abuso de effort/modelo Claude | custo ou argumento inesperado | aliases fechados; modelo completo, effort e combinação revalidados no protocolo v4; argv fixo | testes de catálogo, protocolo, normalização e executor |
| Escape de filesystem | acesso ao host/repositório | Bubblewrap com filesystem mínimo, work/tmp efêmeros e nenhum home completo | smoke Bubblewrap e inspeção de argv |
| Socket acessado por outro usuário | inferência não autorizada | diretório `0700`, socket `0600`, mesmo UID e bind read-only | teste Unix e unidade systemd |
| Saída maliciosa/alucinação de tool | o agente executa ação não oferecida | schema fechado, allowlist de nomes, argumentos JSON, IDs locais e sem heurística de patch | testes de decisão e CLI output |
| DoS/fork/processo órfão | exaustão de CPU/memória/processos | concorrência global 1 sem fila, timeout 10 min, 4 MiB, grupo SIGTERM/SIGKILL e limites systemd | testes de busy, timeout, output e cancelamento |
| Vazamento em logs/erros | exposição de secrets e código | sem bodies/stdout/stderr/prompts; modelo e effort usam allowlists/normalização; erros e health sanitizados | testes e revisão de observabilidade |
| Buffering/SSE inconsistente | cliente travado ou resposta inválida | upstream byte a byte; CLI heartbeat e decisão atômica validada | testes dos dois regimes SSE |
| Mudança de flags/versionamento CLI | perda silenciosa de isolamento | checks de startup e gate por versão; alias omitido quando incapaz | gate real e testes de capacidades |
| Supply chain/container | execução vulnerável | lockfile, `npm ci`, imagem pinada, processo não root e audit | build, audit e smoke local |

O Bubblewrap segue o symlink de `/etc/resolv.conf` ao fazer o bind do arquivo. Somente resolução de nomes, hosts, identidade Unix pública e certificados são montados; `/etc` completo não entra na sandbox.

## Risco residual

- Codex/Claude precisam ler o próprio diretório de autenticação e acessar seus serviços pela rede; o isolamento não elimina o risco intrínseco do binário autenticado.
- Bubblewrap depende de user namespaces e do kernel do host. A unidade deve permanecer restrita ao ambiente pretendido (uso pessoal, LAN/VPN ou VPS autenticado) e atualizada.
- O protocolo OpenAI-compatible do agente cliente e os CLIs são interfaces evolutivas; novos releases exigem repetir os gates antes de publicação.
- Rate limit e cache continuam locais a uma instância.
- O smoke completo de confirmação/edição/cancelamento no computador do agente cliente depende do deploy real e permanece pendente.
- Depois do primeiro heartbeat SSE, o status HTTP não pode mudar; o erro sanitizado é enviado como evento e o stream termina sem `[DONE]`.
