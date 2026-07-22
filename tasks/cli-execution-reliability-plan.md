# Plano de correção definitiva — confiabilidade de execução CLI

## Contexto

Em 22/07/2026, o broker registrou falhas em ambos os providers durante chamadas do
Qwen Code: `InvalidCliOutputError` no Codex 0.144.6 e
`CliExecutionFailedError` no Claude Code 2.1.215. Os erros públicos permanecem
sanitizados, mas o diagnóstico atual não separa de modo suficiente falha de schema,
evento inseguro, resultado estruturado esgotado, encerramento de processo e erro
remoto. Este plano corrige a observabilidade e reduz decisões incompatíveis sem
afrouxar o isolamento ou permitir execução local.

## Estado em 22/07/2026

| Tarefas | Estado | Evidência |
|---|---|---|
| 1 a 7 e 10 | concluídas localmente | ADR-015, 175 testes, cobertura acima dos limiares, audit sem vulnerabilidades altas e documentação sincronizada |
| 8 | pendente manual | gates reais por versão/modelo/modo consomem os logins CLI e não pertencem à suíte comum |
| 9 | pendente operacional | exige deploy coordenado, canário e smoke no Qwen do PC da VPN |

## Restrições inegociáveis

- Não registrar prompts, mensagens, respostas, `structured_output`, argumentos de
  tools, headers, cookies, Authorization, stderr/stdout bruto, paths privados ou
  secrets.
- Não aceitar eventos, tools, comandos, MCP, shell, apps ou subagentes fora das
  allowlists existentes.
- Não adicionar retry automático do gateway/broker depois do primeiro heartbeat;
  nenhum retry pode duplicar uma decisão de tool call.
- Preservar as quatro rotas HTTP públicas, o protocolo privado fechado e o SSE
  sintético atual: após heartbeat, erro termina sem `[DONE]`.
- `runtime/logs/` é operacional e efêmero; deve permanecer ignorado pelo Git e
  nunca ser copiado para imagem, artefato de CI ou documentação de exemplo.

## Tarefas

1. **Registrar ADR da política de confiabilidade e telemetria CLI**

   - Objetivo: fixar a decisão de schema dinâmico, reasons sanitizados, retenção
     local limitada e gate obrigatório por versão de CLI.
   - Escopo: novo ADR; atualização de arquitetura, threat model e contexto do
     orquestrador.
   - Aceite: alternativas (log bruto, tolerar evento desconhecido e retry após
     streaming) são rejeitadas com justificativa; limites de retenção e dados
     proibidos ficam explícitos.
   - Dependências: nenhuma.

2. **Criar diretório de logs de execução seguro**

   - Objetivo: disponibilizar `runtime/logs/` no desenvolvimento e diretório
     privado equivalente no serviço (`LogsDirectory`/`RuntimeDirectory`) para
     acompanhar uma execução enquanto ela ocorre.
   - Escopo: configuração tipada de diretório, criação `0700`, arquivos JSONL
     `0600`, `.gitignore`, Compose/systemd e limpeza/rotação por tamanho e idade.
   - Conteúdo permitido por linha: timestamp, requestId, provider, modelo já
     permitido, effort efetivo, fase, modo/reuso de sessão, duração, bytes do
     transcript, contador de retries e reason sanitizado.
   - Conteúdo proibido: qualquer conteúdo de entrada/saída, tool name/argument,
     dado de autenticação, caminho privado e stderr/stdout do CLI.
   - Aceite: o arquivo aparece no início da execução, recebe eventos de progresso
     durante o turno, é removido/rotacionado conforme política, não entra no Git e
     testes comprovam ausência dos campos proibidos.
   - Dependências: tarefa 1.

3. **Modelar falhas internas por fase e reason seguro**

   - Objetivo: substituir a classificação genérica por erros internos tipados sem
     alterar o contrato público sanitizado.
   - Escopo: reasons para parse de decisão, validação semântica, evento local
     recusado, processo encerrado, limite de saída, resultado Claude e evento
     App Server Codex; propagação para journal, arquivo de execução e métricas.
   - Aceite: `broker_execute_failed` contém somente `reason` pertencente a uma
     enum fechada; `invalid_cli_output` e `cli_execution_failed` públicos não
     passam a expor detalhes; cada reason tem teste de regressão.
   - Dependências: tarefas 1 e 2.

4. **Classificar resultado e retries do Claude Code 2.1.215**

   - Objetivo: distinguir `success`, `error_during_execution`,
     `error_max_structured_output_retries`, limites e encerramento do processo.
   - Escopo: parser `stream-json`, contagem de eventos `system/api_retry`,
     validação estrita do par interno `StructuredOutput`/`tool_result` e
     tratamento fail-closed de eventos desconhecidos.
   - Aceite: cada subtype conhecido gera reason seguro distinto; eventos locais
     continuam bloqueados; retry do próprio CLI é observável por contagem, sem
     registrar a mensagem do provider; fixture reproduz o incidente de 22/07.
   - Dependências: tarefa 3.

5. **Classificar decisão e eventos do Codex App Server 0.144.6**

   - Objetivo: separar decisão ausente, JSON inválido, item inseguro, notificação
     desconhecida e regra semântica da decisão.
   - Escopo: parser de `item/completed`/`turn/completed`, erros tipados e
     telemetria segura; manter as notificações benignas já aprovadas e rejeitar
     MCP, shell, hooks, apps e subagentes.
   - Aceite: as fixtures 0.133 e 0.144 passam; cada desvio conhecido gera reason
     determinístico; nenhuma saída do modelo é escrita nos logs.
   - Dependências: tarefa 3.

6. **Gerar schema de decisão específico por request**

   - Objetivo: fazer Codex e Claude validarem antes de concluir as regras que o
     broker hoje só detecta depois.
   - Escopo: substituir o schema estático por schema fechado que imponha `content`
     XOR `tool_calls`, nomes de tools oferecidas, `tool_choice` e máximo de chamadas
     quando `parallel_tool_calls=false`; aplicar nos modos memory e stateless.
   - Aceite: decisão incompatível não chega à validação final quando o CLI suporta
     schema; a validação final permanece como defesa em profundidade; aliases sem
     tools aceitam apenas texto; argumentos continuam exigindo objeto JSON válido.
   - Dependências: tarefas 4 e 5.

7. **Cobrir regressões de protocolo, logs e SSE**

   - Objetivo: garantir que a correção não relaxe a fronteira de segurança nem
     altere o comportamento OpenAI-compatible.
   - Escopo: fixtures para todos os reasons, logs em execução, rotação, permissões,
     Claude 2.1.215, Codex 0.144.6, schema dinâmico, cancelamento e falha após
     heartbeat.
   - Aceite: `npm run check`, `npm run test:coverage` e `npm audit --omit=dev --audit-level=high`
     passam; cobertura não cai abaixo dos limiares; SSE de
     erro continua sem `[DONE]`; testes verificam que textos sensíveis não chegam
     a journal nem a `runtime/logs/`.
   - Dependências: tarefas 2 a 6.

8. **Executar gate real por versão, modelo e modo de sessão**

   - Objetivo: impedir que upgrade de CLI seja publicado com compatibilidade apenas
     simulada.
   - Escopo: gate manual separado da suíte comum para Codex 0.144.6 e Claude
     2.1.215, em `memory` e `stateless`, cobrindo modelos publicados, efforts,
     dez turnos, tool loop, cancelamento e zero eventos locais.
   - Aceite: cada alias publicado obtém 20/20 estruturas, zero evento local,
     categoria mínima definida pelo projeto e benchmark multi-turn; falha remove
     somente o alias afetado da allowlist até novo gate aprovado.
   - Dependências: tarefas 4 a 7.

9. **Implantar de forma controlada e monitorar o incidente**

   - Objetivo: validar a correção no fluxo Qwen sem expor dados nem degradar o
     upstream.
   - Escopo: backup do estado operacional, canário por alias, smoke remoto no PC
     da VPN, monitoramento dos logs de execução e rollback por provider para
     `stateless` ou desabilitado.
   - Aceite: cada chamada canário gera linha inicial, fases intermediárias e linha
     final no log; nenhuma ocorrência de reason crítico durante a janela acordada;
     DeepSeek permanece inalterada; rollback é testado e documentado.
   - Dependências: tarefas 7 e 8.

10. **Atualizar documentação, runbook e contexto canônico**

   - Objetivo: tornar diagnóstico, retenção, versão certificada e operação
     reproduzíveis.
   - Escopo: documentação de providers, sessões, observabilidade, broker,
     incidentes, threat model, ADR, `.env.example`, README quando aplicável e
     `docs/orchestrator-context.json`.
   - Aceite: links internos válidos; runbook descreve como acompanhar `tail` do
     arquivo JSONL sem revelar conteúdo, como coletar `requestId` e como aplicar
     rollback por provider; versão/gates certificados são registrados.
   - Dependências: tarefas 1 a 9.

## Ordem de implantação

1. Aplicar as tarefas 1–3 e validar a ausência de conteúdo sensível nos novos
   logs.
2. Aplicar 4–6 com fixtures; manter ambos os providers em `stateless` apenas se
   o incidente continuar durante a validação.
3. Aprovar tarefa 7 antes de qualquer deploy.
4. Executar tarefa 8 manualmente com contas reais, pois a suíte automatizada não
   pode chamar Codex ou Claude.
5. Fazer canário e monitoramento da tarefa 9; então concluir a documentação.

## Critério de conclusão

A correção estará concluída quando cada falha CLI puder ser atribuída a uma reason
sanitizada, cada decisão inválida for bloqueada antes de chegar ao Qwen, os logs em
execução forem privados e sem conteúdo, os gates reais das versões instaladas
passarem e o smoke Qwen multi-turn confirmar Codex e Claude sem evento local.
