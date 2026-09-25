# Incidente: renovação OAuth do Claude falhando sem diagnóstico

## Resumo

Em 23/09/2026, entre 17:49 e 17:50 UTC, toda requisição para
`claude-cli-opus-4.8` (stream e não stream, effort `medium` e `high`) recebeu
`502` com `"error":"OAuthRefreshFailedError"` no log. `/health` seguiu `200` e
os demais provedores não foram afetados. Severidade operacional: P2 (um
provedor indisponível, sem fallback, por design).

## Diagnóstico

- O arquivo `secrets/claude-oauth.json` não era modificado desde 25/08/2026.
  Toda renovação bem-sucedida regrava o arquivo, então nenhuma teve sucesso
  desde essa data.
- O container roda como `node` (uid 1000), o mesmo dono do arquivo. Permissão
  de escrita foi descartada.
- As falhas duravam de 170 a 1300 ms, compatível com resposta HTTP de erro, não
  com timeout.
- O status e o código OAuth devolvidos pela Anthropic eram descartados pelo
  `catch {}` do token-store, então não foi possível confirmar a causa pelo log.

Nenhum token, prompt ou corpo foi lido ou registrado durante o diagnóstico.

## Causa

- **Provável (não confirmada):** refresh token do Claude expirado, revogado ou
  já rotacionado.
- **Contribuintes no gateway:**
  1. o motivo da recusa era descartado, o que impedia o diagnóstico;
  2. o cache em memória nunca era descartado após a falha, então um novo login
     só valia após reiniciar o processo;
  3. se a gravação do arquivo falhasse depois de uma renovação bem-sucedida, o
     refresh token rotacionado era perdido.

## Correção

Descrita em [Renovação de token OAuth](../../modules/providers/oauth-token-renewal.md):

- o log da requisição passou a trazer `oauthRefreshStatus` e `oauthRefreshError`
  sanitizados por allowlist;
- o cache é descartado na falha, e o próximo pedido relê o arquivo;
- o token renovado fica em memória antes da gravação.

A resposta pública (`502 oauth_refresh_failed`) não mudou.

## Recuperação operacional

```bash
npm run login:claude -- secrets/claude-oauth.json
docker compose up -d --build gateway   # aplica a correção; depois dela, novos logins não exigem restart
```

## Evidência

- testes de regressão em `test/oauth-token-store.test.ts`,
  `test/oauth-http-error.test.ts`, `test/oauth-claude.test.ts`,
  `test/oauth-codex.test.ts` e `test/cli-gateway.integration.test.ts`;
- `npm run check`.
