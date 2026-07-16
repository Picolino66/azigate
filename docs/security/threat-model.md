# Modelo de ameaças

Data da revisão: 14/07/2026. Escopo: código local, container, Compose e exemplo Nginx. Nenhum sistema de terceiros ou produção será testado.

## Ativos

- chave real da DeepSeek;
- chaves de acesso ao gateway;
- prompts, código-fonte, tool arguments e respostas do modelo;
- disponibilidade e cota financeira da conta DeepSeek.

## Ameaças e controles

| Ameaça | Impacto | Controle obrigatório | Evidência planejada |
|---|---|---|---|
| Proxy aberto/SSRF | acesso a hosts internos ou terceiros | base validada na inicialização; paths fixos; nenhuma URL no contrato público | testes de rotas e revisão do adaptador |
| Roubo/substituição de credencial | uso indevido ou vazamento | Bearer local obrigatório; comparação por digest em tempo constante; Authorization reconstruído | testes de autenticação e upstream mock |
| Vazamento em logs/erros | exposição de segredos e código | redaction do logger; nenhum body em logs; sanitização de erros | teste de sanitização e varredura de secrets |
| Abuso de cota | custo e indisponibilidade | rate limit por chave e IP; allowlists opcionais de IP/modelo | testes 429/403 |
| Payload excessivo | memória/CPU | limite Fastify e Nginx; Content-Type JSON obrigatório | teste 413/415 |
| Slow upstream/conexão órfã | esgotamento de sockets | connect/total timeout; AbortController no cancelamento; graceful shutdown | testes timeout/cancelamento |
| Confusão de headers | spoofing/encaminhamento de segredo | allowlist explícita de headers em ambas as direções | revisão e teste do mock upstream |
| Buffering de SSE | quebra do Cline e uso elevado de memória | streaming byte a byte; Nginx buffering/cache/gzip off | teste multichunk e documentação curl `-N` |
| Supply chain/container | execução privilegiada ou pacote vulnerável | lockfile, `npm ci`, imagem oficial fixa, usuário não root, auditoria de dependências | build e auditoria local |

## Risco residual

- Rate limit e cache são locais a uma instância.
- Um operador com acesso às variáveis/secret files pode alterar credenciais e upstream; isso pertence à fronteira administrativa.
- Depois de um SSE começar, o status HTTP não pode ser trocado; falhas posteriores são encerradas ou repassadas conforme recebido.

