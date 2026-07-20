# ADR-008 — Aliases Codex com modelo fixo

- Status: aceito
- Fase: evolução F2/F3
- Data: 17/07/2026
- Complementa: ADR-005 e ADR-006

## Contexto

O operador precisa escolher a família/modelo usada pela sessão autenticada do Codex sem entregar ao cliente o controle de argv, configuração ou destino do subprocesso.

## Opções consideradas

- Permitir que o cliente informe o modelo interno livremente: flexível, mas transforma um campo HTTP em controle operacional do CLI.
- Criar uma configuração ou broker por modelo: evita campo no protocolo, mas duplica operação e não escala para aliases.
- Mapear aliases públicos fechados para modelos internos fechados: mantém seleção explícita e conserva o argv sob controle do broker.

## Decisão

Publicar `codex-cli-sol`, `codex-cli-terra`, `codex-cli-luna`, `codex-cli-5.5` e `codex-cli-5.4`. Cada alias mapeia respectivamente para `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` e `gpt-5.4`. O alias legado `codex-cli` permanece como sinônimo de `gpt-5.4`.

O protocolo privado passa para v2 e aceita `model` somente em requisições Codex, validado contra essa allowlist. O broker acrescenta esse valor ao argv fixo como `--model`; o cliente nunca controla esse campo diretamente.

## Trade-offs e consequências

Gateway e broker precisam ser atualizados juntos por causa da versão v2. O catálogo indica que o Codex está disponível, mas a elegibilidade da conta para cada modelo precisa ser comprovada pelo gate/manual smoke correspondente. Não há fallback para o modelo padrão ou outro alias.
