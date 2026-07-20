# Provider de upstream (OpenAI-compatible)

## Descrição

Adaptador HTTPS para o upstream OpenAI-compatible configurado pelo operador (por
padrão a DeepSeek; pode ser OpenAI, OpenRouter, Together, Groq, Mistral ou local via
Ollama/LM Studio/vLLM). Mantém o comportamento de passthrough do gateway. No código,
a classe é `DeepSeekClient` (nome histórico).

## Localização no código

`src/upstream/`, `src/routes/chat.ts` e `src/models/service.ts`.

## Entrada

Qualquer modelo não reservado que passe por `ALLOWED_MODELS`; body OpenAI-compatible opaco após validação mínima de `model` e `messages`.

## Saída

Na rota de chat, status, corpo JSON ou SSE do upstream; respostas bufferizadas são sanitizadas e SSE é copiado byte a byte. Na rota de modelos, o array válido contribui para o catálogo combinado; falha do upstream permite degradação para aliases locais e somente vira `503` quando nenhum provider é utilizável.

## Dependências

`DEEPSEEK_BASE_URL`, `DEEPSEEK_API_KEY` (nomes históricos; apontam para qualquer provedor OpenAI-compatible), Undici e saída HTTPS. Em produção a base precisa ser HTTPS.

## Regras de negócio

- Somente `models` e `chat/completions` são paths válidos, construídos sobre `DEEPSEEK_BASE_URL`.
- Authorization recebido do cliente nunca segue ao upstream; é reconstruído com `DEEPSEEK_API_KEY`.
- Campos desconhecidos, tools e `reasoning_content` permanecem opacos.
- Retry limitado ocorre somente antes do início da resposta.

## Fluxo resumido

Resolver como upstream -> reconstruir headers -> fetch HTTPS -> preservar resposta segura -> propagar cancelamento.

## Possíveis erros

`upstream_connection_error`, `upstream_protocol_error`, `upstream_timeout` e qualquer status seguro devolvido pelo upstream.
