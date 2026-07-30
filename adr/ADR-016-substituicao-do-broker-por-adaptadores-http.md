# ADR-016 — Substituição do broker por adaptadores HTTP nativos

- Status: aceito
- Fase: migração F2/F5 (broker → adaptadores HTTP)
- Data: 27/07/2026
- Substitui: ADR-005 (parte relativa ao broker local), ADR-013

## Contexto

O broker host executava `codex exec`/App Server e `claude --print` em Bubblewrap, serializava
toda a conversa em um prompt de texto e pedia ao modelo que devolvesse um envelope
`{content, tool_calls}` validado por JSON Schema. O tradutor OpenAI era o próprio modelo, não
código determinístico. Os incidentes registrados em [docs/operations/incidents/](../docs/operations/incidents/)
em 20, 22 e 23/07/2026 têm a mesma origem: `invalid_cli_output`, drift de flags internas
(`--output-schema`), e falha de retry do App Server. Nenhum deles é uma falha do isolamento —
todos nascem da tradução via linguagem natural.

Verificado nas versões instaladas (codex-cli 0.144.6, Claude Code 2.1.215): não existe
superfície suportada para injetar function tools nas CLIs. `claude --tools` aceita apenas o
conjunto embutido e `codex exec` aceita apenas um prompt de texto. O envelope de decisão não
era uma escolha de design ruim — era a única expressão possível dentro dessa restrição. O teto
de confiabilidade da arquitetura anterior vinha junto com ela.

## Opções consideradas

- Manter o broker e continuar endurecendo o prompt/schema de decisão: reduziria a taxa de
  incidentes marginalmente, mas não elimina a causa raiz — o modelo continua podendo
  desobedecer instruções em linguagem natural, e as flags internas (`--output-schema`,
  protocolo App Server) continuam voláteis entre releases.
- Reescrever o broker sobre outro mecanismo de IPC preservando subprocessos: não muda o fato
  de que a CLI é um agente, não um endpoint; o problema de tradução via modelo permanece.
- Substituir o broker por adaptadores HTTP diretos contra a Messages API (Anthropic) e a
  Responses API (OpenAI/Codex), com uma camada de tradução determinística em TypeScript: a
  opção escolhida. `tool_choice`, `parallel_tool_calls` e o restante da semântica OpenAI passam
  a ser campos de corpo HTTP, garantidos pelo backend do fornecedor.

## Decisão

Remover `src/broker/` inteiro, `src/providers/broker-client.ts`, `src/providers/openai-response.ts`
(regime sintético), a unidade systemd do broker e os testes correspondentes. Introduzir:

- `src/translation/openai-to-anthropic.ts`, `anthropic-to-openai.ts`,
  `openai-to-responses.ts`, `responses-to-openai.ts`, `state.ts` — funções puras, síncronas,
  sem I/O, testáveis por tabela;
- `src/providers/anthropic-client.ts` e `src/providers/codex-client.ts` — clientes Undici
  seguindo o padrão de [src/upstream/client.ts](../src/upstream/client.ts): paths tipados,
  `redirect: 'error'`, allowlist de headers, HTTPS obrigatório em produção, cancelamento do
  cliente propagado.

`src/cli-catalog.ts` é preservado: os aliases `codex-cli-*` e `claude-cli-*` continuam sendo o
contrato público. Muda apenas o adaptador para onde eles roteiam — de socket Unix para HTTPS.

O registry (`src/providers/registry.ts`) continua fechado e sem fallback automático entre
provedores. Essa invariante não muda; apenas o destino de `kind: 'cli'` muda de broker para
cliente HTTP direto.

## Invariantes do CLAUDE.md reescritas por esta decisão

| Invariante anterior | Nova redação |
| --- | --- |
| "O upstream usa apenas os paths tipados `models` e `chat/completions`" | Cada adaptador (DeepSeek, Anthropic, Codex/Responses) tem paths tipados e fechados; nenhum aceita path, host ou URL do cliente. |
| "Subprocessos do broker usam `spawn` sem shell, argv fixo, ambiente mínimo, grupo de processos, limite de tempo/saída, concorrência global 1 sem fila e Bubblewrap" | Removida. Não há mais subprocesso; a garantia de isolamento passa a ser a ausência estrutural de execução local, não uma sandbox. |
| "O protocolo do broker aceita somente request ID, provider, mensagens e ferramentas normalizadas" | Removida. Os adaptadores recebem o corpo OpenAI-compatible e traduzem para o corpo nativo de cada fornecedor; não há protocolo IPC intermediário. |
| "A validação textual/function tool adicional vale somente para aliases CLI" | Removida. Passthrough completo de campos OpenAI-compatible desconhecidos passa a valer para todos os provedores, inclusive os aliases CLI. |
| "O agente cliente é o único executor" | Reforçada. Sem subprocesso algum, a garantia de que nenhuma ferramenta é executada localmente pelo gateway passa a ser estrutural, não imposta por sandbox. |

## Trade-offs e consequências

Ganha-se determinismo: a tradução OpenAI↔Anthropic/Responses é código puro testável por tabela,
elimina `invalid_cli_output` e `cli_execution_failed` como classes de erro, e habilita streaming
incremental real, tool calling nativo, multimodal e structured outputs.

Perde-se o isolamento por Bubblewrap/subprocesso — mas essa camada existia para conter um
processo de terceiros com ferramentas embutidas; deixando de invocar esse processo, a
superfície que ela protegia deixa de existir. Em contrapartida, nasce uma nova superfície: dois
upstreams adicionais com segredos próprios (ver ADR-018) e uma camada de tradução que manipula
conteúdo do usuário diretamente em código do gateway — precisa do mesmo padrão de sanitização de
logs já aplicado ao DeepSeek (ADR-004), sem exceção.

A camada de tradução vira código crítico: qualquer regressão nela afeta 100% do tráfego CLI. Por
isso a Fase 1 da migração exige cobertura de teste acima de 90% e tabela de casos cobrindo cada
linha da especificação de tradução, não apenas o gate geral de 80%/70%.
