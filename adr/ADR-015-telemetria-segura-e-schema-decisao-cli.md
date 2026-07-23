# ADR-015 — Telemetria segura e schema de decisão por execução CLI

## Status

Aceita em 22/07/2026. Complementa ADR-004, ADR-006, ADR-007 e ADR-014.

## Contexto

Codex 0.144.6 e Claude Code 2.1.215 produziram falhas cuja classificação pública
era necessariamente genérica (`invalid_cli_output` ou `cli_execution_failed`). O
journal preservava somente o nome da classe e não permitia separar schema inválido,
evento local bloqueado, processo encerrado e resultado estruturado esgotado. Gravar
saídas brutas para diagnosticar seria incompatível com a política de não persistir
prompts, respostas, argumentos ou credenciais.

O schema estático de decisão também permitia combinações que a validação semântica
posterior recusava, como texto junto de tools ou tool fora da seleção atual.

## Alternativas consideradas

1. Registrar stdout, stderr ou a decisão do CLI: facilita depuração, mas persiste
   conteúdo sensível e foi rejeitado.
2. Ignorar eventos novos dos CLIs: reduz erros aparentes, mas pode aceitar execução
   local e foi rejeitado.
3. Reexecutar automaticamente após o primeiro heartbeat: pode alongar streams e
   duplicar uma decisão de tool call; foi rejeitado.
4. Registrar reasons fechados, gerar schema por request e manter a validação final
   como defesa em profundidade.

## Decisão

- O broker grava JSONL em diretório privado configurado por
  `BROKER_EXECUTION_LOG_DIR`. No desenvolvimento, o padrão é `runtime/logs/`; a
  unidade systemd usa `/run/azigate/logs`.
- Cada linha contém somente metadados permitidos e uma reason de enum fechada. Os
  arquivos são `0600`, o diretório é `0700` e a retenção é limitada por tamanho e
  quantidade de arquivos.
- Cada execução registra recebimento, despacho, preparação, início/fim de turno,
  validação, conclusão ou falha. Falha de escrita do log nunca interrompe o broker.
- Codex e Claude recebem schema específico do request, impondo texto XOR tools,
  nomes permitidos, `tool_choice` e limite de chamadas paralelas.
- Eventos desconhecidos, locais ou inseguros continuam fail-closed. A resposta
  pública e o protocolo v6 não expõem reasons internos.

## Consequências

O operador pode acompanhar execução com `tail` do JSONL sem acessar conteúdo da
conversa. Upgrades de CLI exigem gate real por versão/modelo/modo; o modo
`stateless` permanece como rollback explícito. A decisão final continua sendo
validada pelo gateway, pois schema de provider não substitui a defesa local.

## Adendo de 23/07/2026

O validador de structured outputs da OpenAI rejeita `oneOf`/`anyOf` na raiz e
arrays sem `items`, o que invalidava o schema em dois ramos sempre que o request
tinha tools com `tool_choice` auto. O schema por request passou a ser um único
objeto plano; o XOR texto/tools deixa de ser imposto pelo schema e fica
integralmente sob `validateCliDecision`, que já executava no broker e no
gateway. Complementarmente, o `codexErrorInfo` da notificação terminal do App
Server é classificado em enum fechado e gravado como `errorCode` no JSONL — a
mensagem do provedor continua nunca sendo registrada. Evidência e reprodução em
`docs/operations/incidents/2026-07-23-output-schema-rejeitado-structured-outputs.md`.
