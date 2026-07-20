# Modelo de ameaças

Data da revisão: 20/07/2026. Escopo: gateway, adaptador de upstream, broker host, subprocessos Codex/Claude, container, Compose, systemd e Nginx. O computador do agente cliente não foi alterado nem testado neste ciclo.

## Ativos

- chave do upstream e chaves Bearer do gateway;
- sessões e diretórios de autenticação `~/.codex` e `~/.claude`, incluindo o
  arquivo top-level `~/.claude.json`;
- prompts, código-fonte, tool arguments, resultados e respostas;
- repositórios no computador do agente cliente;
- disponibilidade e cotas dos provedores.

## Fronteiras de confiança

1. Agente cliente -> Nginx/gateway: rede não confiável, protegida por TLS, Bearer, allowlists e limites.
2. Gateway -> upstream: HTTPS para base e paths fixos, com credencial reconstruída.
3. Container -> broker: protocolo HTTP v6 sobre Unix socket privado; o mount é read-only.
4. Broker -> CLI: processo e saída não confiáveis, contidos por argv fixo, ambiente limpo, Bubblewrap e schema.
5. Agente cliente -> repositório: única fronteira com capacidade de leitura, shell e edição, sujeita à confirmação do usuário.

## Ameaças e controles

| Ameaça | Impacto | Controle implementado | Evidência |
|---|---|---|---|
| Proxy aberto/SSRF | acesso a hosts internos ou terceiros | quatro rotas públicas; registry fechado; base/paths do upstream fixos; broker recusa URL/path | testes de rotas, registry e protocolo |
| Confusão de provedor/fallback | envio de dados ao provedor errado | aliases reservados e sem fallback automático | testes de roteamento e catálogo |
| Roubo/substituição de credencial | uso indevido ou vazamento | Bearer local, comparação constante, Authorization reconstruído e separação container/broker | regressão de auth e mounts do Compose |
| Vazamento do login CLI | controle da conta Codex/Claude | auth dirs `0700`, arquivos `0600`, home oculto por systemd, somente `auth.json`/`.credentials.json` montados nas sessões e cópia efêmera da configuração Claude | check de capacidade, systemd, permissões e testes de isolamento |
| Prompt injection solicitando host/shell | leitura ou alteração do servidor | CLI sem ferramentas, sem repositório/home, `/work` descartável, eventos de execução rejeitados | cenários de gate, testes de argv e output |
| Injeção de comando no broker | execução arbitrária | protocolo não possui comando/cwd/argv/env; `spawn` com `shell: false` e argv fixo | testes de protocolo e fake runner |
| Abuso de effort/modelo CLI | custo ou argumento inesperado | aliases fechados; modelo completo, effort efetivo e combinação revalidados no protocolo v6; argv/RPC reconstruídos | testes de catálogo, protocolo, normalização e executor |
| Escape de filesystem | acesso ao host/repositório | Bubblewrap com filesystem mínimo, work/tmp/home efêmeros, nenhum home completo e nenhuma montagem do `.claude.json` original | smoke Bubblewrap, inspeção de argv e teste de imutabilidade do original |
| Socket acessado por outro usuário | inferência não autorizada | diretório `0700`, socket `0600`, mesmo UID e bind read-only | teste Unix e unidade systemd |
| Saída maliciosa/alucinação de tool | o agente executa ação não oferecida | schema fechado, allowlist de nomes, argumentos JSON, IDs locais e sem heurística de patch | testes de decisão e CLI output |
| DoS/fork/processo órfão | exaustão de CPU/memória/processos | concorrência global 1 sem fila, transcript 256 KiB, timeout 10 min, 4 MiB por turno, até 4 sessões, TTL/LRU, interrupção/grupo SIGTERM/SIGKILL e limites systemd | testes de limite, sessão, busy, timeout, output e cancelamento |
| Confusão entre sessões | vazamento de contexto entre conversas | hashes SHA-256, IDs de tool calls normalizados, modelo/tools no fingerprint e reuso somente com um único prefixo exato | testes de prefixo, divergência e ambiguidade |
| Persistência indevida de transcript | exposição após restart | somente RAM; threads Codex efêmeras; Claude sem session persistence; work/home removidos em TTL, LRU, crash ou shutdown | testes com CLIs falsos e inspeção de artefatos |
| Telemetria de usage incorreta | diagnóstico/custo enganoso | parsers separados; cache/reasoning tratados como parcelas ou subconjuntos conforme provider | fixtures Claude/Codex e incidente documentado |
| Vazamento em logs/erros | exposição de secrets e código | sem bodies/stdout/stderr/prompts; modelo e effort usam allowlists/normalização; erros e health sanitizados | testes e revisão de observabilidade |
| Buffering/SSE inconsistente | cliente travado ou resposta inválida | upstream byte a byte; CLI heartbeat e decisão atômica validada | testes dos dois regimes SSE |
| Mudança de flags/versionamento CLI | perda silenciosa de isolamento | checks de startup e gate por versão; alias omitido quando incapaz | gate real e testes de capacidades |
| Supply chain/container | execução vulnerável | lockfile, `npm ci`, imagem pinada, processo não root e audit | build, audit e smoke local |

O Bubblewrap segue o symlink de `/etc/resolv.conf` ao fazer o bind do arquivo. Somente resolução de nomes, hosts, identidade Unix pública e certificados são montados; `/etc` completo não entra na sandbox.

## Risco residual

- Codex/Claude precisam ler o próprio diretório de autenticação e acessar seus
  serviços pela rede; Claude também lê uma cópia efêmera de sua configuração. O
  isolamento não elimina o risco intrínseco do binário autenticado.
- Bubblewrap depende de user namespaces e do kernel do host. A unidade deve permanecer restrita ao ambiente pretendido (uso pessoal, LAN/VPN ou VPS autenticado) e atualizada.
- O protocolo OpenAI-compatible do agente cliente e os CLIs são interfaces evolutivas; novos releases exigem repetir os gates antes de publicação.
- Rate limit e cache continuam locais a uma instância.
- Sessões em RAM ampliam o tempo de vida do processo autenticado até TTL/eviction.
  Comprometimento do broker durante esse intervalo pode expor estado em memória;
  não há persistência para recuperá-lo após restart.
- A porcentagem das cotas Claude/Codex aplica pesos não expostos. Tokens lógicos
  e custo estimado não garantem equivalência com a UI do plano.
- O smoke completo de confirmação/edição/cancelamento no computador do agente cliente depende do deploy real e permanece pendente.
- Depois do primeiro heartbeat SSE, o status HTTP não pode mudar; o erro sanitizado é enviado como evento e o stream termina sem `[DONE]`.
