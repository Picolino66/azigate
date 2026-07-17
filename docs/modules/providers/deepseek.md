# Provider DeepSeek

## Descrição

Adaptador HTTPS compatível com o comportamento anterior do gateway.

## Localização no código

`src/upstream/`, `src/routes/chat.ts` e `src/models/service.ts`.

## Entrada

Qualquer modelo não reservado que passe por `ALLOWED_MODELS`; body OpenAI/DeepSeek opaco após validação mínima de `model` e `messages`.

## Saída

Na rota de chat, status, corpo JSON ou SSE da DeepSeek; respostas bufferizadas são sanitizadas e SSE é copiado byte a byte. Na rota de modelos, o array válido contribui para o catálogo combinado; falha da DeepSeek permite degradação para aliases locais e somente vira `503` quando nenhum provider é utilizável.

## Dependências

`DEEPSEEK_BASE_URL`, `DEEPSEEK_API_KEY`, Undici e saída HTTPS.

## Regras de negócio

- Somente `models` e `chat/completions` são paths válidos.
- Authorization recebido nunca segue ao upstream.
- Campos desconhecidos, tools e `reasoning_content` permanecem opacos.
- Retry limitado ocorre somente antes do início da resposta.

## Fluxo resumido

Resolver como DeepSeek -> reconstruir headers -> fetch HTTPS -> preservar resposta segura -> propagar cancelamento.

## Possíveis erros

`upstream_connection_error`, `upstream_protocol_error`, `upstream_timeout` e qualquer status seguro devolvido pela DeepSeek.
