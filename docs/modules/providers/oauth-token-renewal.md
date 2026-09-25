# Renovação de token OAuth

## Descrição

Os adaptadores Codex e Claude usam o token OAuth da assinatura do operador
([ADR-018](../../../adr/ADR-018-credencial-oauth-da-assinatura.md)). O access token
é renovado sob demanda, antes da requisição ao provedor, quando está a menos de
60 s de expirar.

## Localização no código

- `src/providers/oauth/token-store.ts`: leitura/gravação do arquivo, cache em
  memória, renovação deduplicada e diagnóstico da falha;
- `src/providers/oauth/claude-oauth.ts` / `src/providers/oauth/codex-oauth.ts`:
  chamada `grant_type=refresh_token` a cada endpoint de token;
- `src/providers/oauth/oauth-http-error.ts`: erro HTTP comum e extração
  sanitizada do código OAuth;
- `src/providers/errors.ts`: `OAuthRefreshFailedError` e `OAuthRefreshDiagnostic`;
- `src/app.ts`: hook `onError` que copia o diagnóstico para a telemetria.

## Entrada

Arquivo `CLAUDE_TOKEN_FILE`/`CODEX_TOKEN_FILE` com `accessToken`, `refreshToken`
e `expiresAt`, criado por `npm run login:claude -- <arquivo>`/`npm run login:codex -- <arquivo>`
(ver [instalação no Linux](../../installation/linux.md)).

## Saída

Access token válido para o adaptador ou, em falha, `502 oauth_refresh_failed`
na resposta pública e os campos `oauthRefreshStatus`/`oauthRefreshError` no log
da requisição.

## Dependências

Undici e os endpoints de token `https://api.anthropic.com/v1/oauth/token` e
`https://auth.openai.com/oauth/token`.

## Regras de negócio

- Renovações concorrentes são deduplicadas em uma única chamada.
- O token renovado vai para a memória **antes** de ser gravado: se a gravação
  falhar, o refresh token rotacionado pelo provedor não se perde.
- Se a renovação falhar, o cache em memória é descartado. A próxima requisição
  relê o arquivo, então um novo `npm run login:*` vale **sem reiniciar** o gateway.
- O diagnóstico contém somente:
  - `status`: status HTTP do endpoint de token, quando houve resposta HTTP;
  - `oauthError`: o campo `error` da resposta (`{"error":"invalid_grant"}`) ou
    `error.code`/`error.type` no formato aninhado, aceito apenas se casar com
    `^[a-z][a-z0-9_.-]{0,63}$` (sem diferenciar maiúsculas); valores sintéticos:
    `nao_informado` (sem código reconhecível), `resposta_invalida` (2xx com
    formato inesperado) e `falha_de_transporte` (sem resposta HTTP: DNS, TLS,
    conexão, JSON inválido).
- Do corpo de erro, só os primeiros 4 KiB são lidos. `error_description`,
  mensagens livres e tokens nunca são registrados.
- O diagnóstico não entra na resposta pública, que continua sendo a mensagem
  genérica de `oauth_refresh_failed`.

## Fluxo resumido

Adaptador pede o token -> cache ou arquivo -> dentro da janela de expiração? ->
`refresh_token` no endpoint do provedor -> sucesso: memória e depois arquivo
`0600` -> falha: limpa o cache, monta o diagnóstico e lança
`OAuthRefreshFailedError` -> `onError` registra `oauthRefreshStatus` e
`oauthRefreshError`.

## Possíveis erros

| Log | Interpretação provável | Ação |
|---|---|---|
| `oauthRefreshStatus: 400`, `oauthRefreshError: invalid_grant` | refresh token expirado, revogado ou já rotacionado | `npm run login:<provedor>` no host |
| `oauthRefreshStatus: 401`/`403` | client/credencial recusados pelo provedor | refazer o login; se persistir, verificar mudança do fluxo OAuth (threat model) |
| `oauthRefreshStatus: 429` ou `5xx` | limite ou indisponibilidade do provedor | aguardar; o próximo pedido tenta de novo |
| `oauthRefreshError: falha_de_transporte` | sem resposta HTTP (rede, DNS, TLS) | verificar a conectividade de saída do container |
| `oauthRefreshError: resposta_invalida` | 2xx sem os campos de token esperados | possível mudança de contrato do provedor |

Sem token em disco: `503 oauth_not_logged_in`.
