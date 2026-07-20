# Plano rastreável de evolução multiprovedor

## Contexto

Evoluir o monólito Fastify existente sem alterar suas quatro rotas públicas. A DeepSeek permanece transparente; Codex e Claude são adaptadores experimentais, sem ferramentas, acionados por broker host. O Qwen Code no computador da VPN continua responsável por ler, executar e alterar o repositório.

## Estado em 20/07/2026

| Tarefa | Estado | Evidência principal |
|---|---|---|
| 1. ADRs | concluída | ADR-005 a ADR-013 |
| 2. Contrato/prompt | evoluída | protocolo v5, modelos/efforts fechados e testes fail-closed |
| 3. Núcleo multiprovedor | concluída | registry, catálogo/readiness e rename `gateway-ai` |
| 4. Cliente/respostas CLI | concluída | Unix socket, JSON/SSE, erros e cancelamento |
| 5. Broker isolado | concluída | Bubblewrap, systemd, socket privado e limites |
| 6. Codex/Claude | concluída localmente | cinco modelos Claude aprovados; três reprovados individualmente no gate real 2.1.214 |
| 7. Deploy | concluída como artefato | Compose, systemd, imagem e smoke local aprovados |
| 8. Qwen remoto | documentada, smoke pendente | runbook completo; requer PC da VPN |
| 9. Qualidade/segurança | concluída localmente | logs com cor única por alias e effort seguro; cobertura, audit e revisão de segurança |
| 10. Fonte de verdade | concluída | docs/specs/ADRs/contexto sincronizados |
| 11. Effort Qwen/Codex | implementada, deploy pendente | `reasoning.effort`, precedência, defaults, clamp Codex e testes de regressão |
| 12. Incidente de configuração Claude | corrigida localmente, deploy pendente | home efêmero, cópia privada de `.claude.json`, regressões e ADR-012; smoke real alcançou a API e recebeu `429` externo |
| 13. Compatibilidade Codex 0.144.6 | implementada, deploy pendente | check por catálogo JSON; smokes Sol/Terra/Luna aprovados; ADR-013 |

O5 continua sendo o último snapshot estável até o smoke Qwen e o deploy LAN/TLS reais. Os aliases permanecem desligados por padrão; a aprovação dos gates não os publica automaticamente.

## Arquitetura e contratos

1. **Registrar decisões multiprovedor**
   - Objetivo: preservar O5 e abrir a reavaliação F2/F3.
   - Escopo: ADR-005, ADR-006, ADR-007 e notas de substituição parcial.
   - Aceite: registry, fronteira do broker, executor único e streaming dividido possuem decisões rastreáveis.
   - Dependências: nenhuma.

2. **Definir contrato interno e prompt canônico**
   - Objetivo: limitar a tradução OpenAI para CLI a dados estritamente necessários.
   - Escopo: protocolo v5, mensagens textuais, modelos Codex/Claude fechados, effort comum revalidado por modelo, function tools, schema de decisão, erros e validação de transcript.
   - Aceite: entrada rejeita cwd/comando/URL/path; saída aceita somente texto ou tool calls permitidas com JSON válido.
   - Dependências: tarefa 1.

## Backend

3. **Extrair o núcleo multiprovedor**
   - Objetivo: rotear aliases reservados sem regressão no adaptador DeepSeek.
   - Escopo: registry, catálogo combinado, readiness e rename operacional para `gateway-ai`.
   - Aceite: modelos DeepSeek seguem opacos; alias desabilitado não cai na DeepSeek; nenhum provedor utilizável produz `503`.
   - Dependências: tarefa 2.

4. **Implementar cliente do broker e respostas CLI**
   - Objetivo: integrar Unix socket e normalizar Chat Completions.
   - Escopo: timeouts, cancelamento, erros, JSON e SSE com heartbeat.
   - Aceite: tool call recebe ID local; falha após heartbeat encerra sem `[DONE]`; DeepSeek continua byte a byte.
   - Dependências: tarefa 3.

5. **Implementar broker host isolado**
   - Objetivo: executar CLIs sem shell, repositório ou configuração herdada.
   - Escopo: servidor Unix, concorrência global 1, limite 4 MiB, grupos de processos, Bubblewrap, ambiente mínimo e checks de capacidade.
   - Aceite: socket `0600`, diretório `0700`, timeout mata o grupo, segunda execução recebe `cli_busy` e eventos de ferramenta são recusados.
   - Dependências: tarefa 2.

6. **Adicionar adaptadores Codex e Claude**
   - Objetivo: usar os logins existentes e modelos Codex/Claude explicitamente fixados por alias.
   - Escopo: argv fixo, schema final, controles documentados, gate de 10 cenários executado duas vezes por modelo.
   - Aceite: alias só fica saudável com 100% de estrutura válida, zero ferramenta local e ao menos 90% de categoria correta; nenhuma API key nova.
   - Dependências: tarefa 5.

## Infraestrutura e operação

7. **Integrar broker ao deploy**
   - Objetivo: manter credenciais CLI somente no host.
   - Escopo: unidade systemd endurecida, bind read-only do diretório do socket e variáveis seguras.
   - Aceite: Compose válido, container sem homes CLI, broker sem chaves do gateway e rollback documentado.
   - Dependências: tarefas 4 e 5.

8. **Documentar Qwen Code e smoke remoto**
   - Objetivo: configurar o cliente no computador da VPN sem exigir atualização.
   - Escopo: `modelProviders` quando disponível e variáveis OpenAI como fallback; confirmações habilitadas.
   - Aceite: runbook cobre modelos, chat, tool result, cancelamento, troca de provedor e confirmações.
   - Dependências: tarefa 4.

## Qualidade e segurança

9. **Cobrir regressões e casos de abuso**
   - Objetivo: provar isolamento, contrato e compatibilidade.
   - Escopo: testes unitários, broker falso, integração Unix, regressão DeepSeek, prompt injection e logs.
   - Aceite: `npm run check`, cobertura mínima, audit sem High, nenhum secret/conteúdo em logs.
   - Dependências: tarefas 3 a 7.

10. **Sincronizar fonte de verdade**
    - Objetivo: manter implementação, OpenAPI, segurança e contexto coerentes.
    - Escopo: módulos providers, arquitetura, specs, README, env, threat model, inventário e OrchestratorContext.
    - Aceite: links internos válidos; O5 preservado até gates; pendências manuais explicitadas.
    - Dependências: todas as anteriores.

11. **Aceitar o effort nativo do Qwen e aplicá-lo ao Codex**
    - Objetivo: fazer `/effort` controlar dinamicamente Codex e Claude sem configuração estática no cliente.
    - Escopo: `reasoning.effort`, compatibilidade com `reasoning_effort`, precedência, defaults, protocolo v5 e `model_reasoning_effort` no Codex.
    - Aceite: formato aninhado chega ao argv fixo; Codex `max` vira `xhigh`; DeepSeek recebe o body original; estrutura inválida falha com `400`.
    - Dependências: tarefas 2, 5, 6 e 10.

12. **Corrigir a configuração Claude dentro do isolamento**
    - Objetivo: permitir que o Claude encontre sua configuração sem expor o home
      real do operador.
    - Escopo: `CLAUDE_CONFIG_PATH`, validação privada, bind read-only no systemd,
      cópia por execução para home efêmero e classificação sanitizada de limite
      remoto.
    - Aceite: original nunca aparece no argv Bubblewrap nem é modificado; cópia
      nasce `0600` e é removida; arquivo ausente/permissivo falha fechado; teste
      real deixa de produzir erro de configuração.
    - Dependências: tarefas 5, 6, 7, 9 e 10.

13. **Adaptar o check de capacidade ao Codex CLI 0.144.6**
    - Objetivo: evitar falso `required_effort_config_missing` após upgrades que
      não rejeitam mais o sentinela em `debug models`.
    - Escopo: catálogo JSON embutido, modelos/efforts exigidos e regressões.
    - Aceite: startup sem inferência; catálogo inválido falha fechado; Sol, Terra
      e Luna executam no Bubblewrap com o argv fixo.
    - Dependências: tarefas 5, 6, 9 e 10.

## Matriz de rastreabilidade

| ID | Requisito | ADR/Spec | Implementação esperada | Evidência |
|---|---|---|---|---|
| GW-01 a GW-10 | comportamento estável DeepSeek | ADR-001 a ADR-004 | módulos existentes | suíte de regressão |
| MP-01 | registry sem fallback | ADR-005 | `src/providers` | testes de roteamento |
| MP-02 | Qwen único executor | ADR-006 | validação + broker | testes de tool calls e isolamento |
| MP-03 | streaming dividido | ADR-007 | resposta CLI + passthrough | SSE sintético e DeepSeek multichunk |
| MP-04 | broker privado | ADR-005/006 | `src/broker` | fake executables e socket Unix |
| MP-05 | catálogo/readiness | spec API | models/health/providers | degradação parcial e `503` |
| MP-06 | operação host/container | threat model | systemd/Compose | verificações de artefatos |
| MP-07 | Qwen remoto | runbook | documentação | smoke manual no PC da VPN |
| MP-08 | seleção Codex por alias | ADR-008 / protocolo v3 | registry + broker | roteamento, argv e catálogo |
| MP-09 | Claude com effort configurável | ADR-009 | normalização + executor Claude | enum, argv, capacidades, gates e smoke Qwen |
| MP-10 | seleção Claude por alias | ADR-010 / protocolo v4 | catálogo central + registry + broker | modelos, matrizes de effort, argv e gates por modelo |
| MP-11 | logs por modelo e effort | docs de observabilidade | telemetria + destino Pino | cores únicas, effort normalizado e sanitização |
| MP-12 | effort nativo do Qwen em Codex/Claude | ADR-011 / protocolo v5 | catálogo + normalização + executores | nested/flat, precedência, clamp, passthrough e argv |
| MP-13 | configuração Claude isolada | ADR-012 / incidente de 20/07 | capabilities + isolation + executor + systemd | arquivo privado, cópia efêmera, original imutável e erro remoto categorizado |
| MP-14 | compatibilidade Codex 0.144.6 | ADR-013 / incidente pós-deploy | capabilities + catálogo Codex | JSON estrutural, falha fechada e smokes Sol/Terra/Luna |
