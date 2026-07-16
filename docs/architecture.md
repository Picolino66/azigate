# Arquitetura do gateway

## Contexto

O Cline alcança o domínio do servidor, mas não alcança diretamente a API da DeepSeek. O serviço precisa terminar uma requisição autenticada do Cline e iniciar outra requisição HTTPS, com uma credencial diferente, para um conjunto fechado de rotas da DeepSeek.

```text
Cline (OpenAI Compatible)
  -> HTTPS ia.meudominio.com/v1
  -> Nginx (TLS, sem buffering)
  -> Fastify em 127.0.0.1:3000
  -> HTTPS api.deepseek.com/{models|chat/completions}
```

## Padrão e módulos

O sistema é um monólito modular e stateless:

- `config`: leitura, validação e suporte a segredos por arquivo;
- `auth`: comparação constante das chaves do gateway;
- `rate-limit`: limites locais em memória por credencial e por IP;
- `upstream`: único adaptador autorizado a construir URLs da DeepSeek;
- `models`: consulta, filtro e cache curto da lista oficial;
- `chat`: validação mínima e passthrough opaco de Chat Completions;
- `streaming`: cópia incremental de bytes e cancelamento cooperativo;
- `observability`: métricas internas e logs estruturados sem conteúdo.

Não há banco de dados, fila, frontend ou endpoint genérico de proxy. O processo pode ser replicado, mas rate limit e cache são locais a cada réplica; uma futura escala horizontal deve substituir esses dois estados por um backend compartilhado.

## Fronteiras de confiança

1. Cliente -> Nginx: tráfego não confiável, HTTPS obrigatório.
2. Nginx -> aplicação: rede local/container, ainda submetida a autenticação e allowlists.
3. Aplicação -> DeepSeek: apenas HTTPS e apenas rotas compiladas no servidor.
4. Ambiente/secret files -> aplicação: fonte confiável de configuração operacional.

## Contratos externos verificados em 14/07/2026

- O [Cline OpenAI Compatible](https://docs.cline.bot/provider-config/openai-compatible) recebe uma Base URL terminada em `/v1`; sua implementação consulta `${baseUrl}/models` e acrescenta `/chat/completions` para chat.
- A [DeepSeek](https://api-docs.deepseek.com/) documenta compatibilidade OpenAI, `POST /chat/completions` e [GET `/models`](https://api-docs.deepseek.com/api/list-models/).
- O streaming da DeepSeek é SSE, pode conter comentários de keep-alive e termina em `data: [DONE]`; os bytes não são reinterpretados pelo gateway.
- A [documentação do Nginx](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering) recomenda desabilitar buffering para repasse imediato da resposta.

