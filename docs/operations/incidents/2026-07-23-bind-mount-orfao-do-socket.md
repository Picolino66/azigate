# Incidente: bind mount órfão do socket após restart do broker

## Resumo

Em 23/07/2026, após o deploy da correção do retry do App Server, todas as
requisições para `codex-cli-terra` responderam `503 cli_unavailable` em menos de
um segundo. Severidade operacional: P2.

## Evidência sanitizada

- O journal do broker não registrou nenhuma linha `broker_execute_failed`: as
  requisições nunca chegaram ao `/execute`.
- O `/health` consultado pelo socket no host respondeu `ready` com Codex e
  Claude disponíveis.
- No host, `/run/azigate` tinha inode novo e continha `broker.sock`; dentro do
  container, o mesmo caminho apontava para o inode antigo e estava vazio.
- O container do gateway subira antes do restart do broker.

## Causa raiz

A unidade usa `RuntimeDirectory=azigate`, e o systemd remove e recria
`/run/azigate` a cada restart do serviço. O bind mount do container continuou
referenciando o diretório apagado, então o socket novo nunca ficou visível e o
cliente do broker converteu a falha de conexão em `CliUnavailableError`.

## Correção

- `RuntimeDirectoryPreserve=yes` na unidade preserva o inode de `/run/azigate`
  entre restarts do serviço (no boot o diretório continua efêmero, pois `/run`
  é tmpfs).
- Operacionalmente, um restart do broker feito com a unidade antiga ainda exige
  `docker compose up -d --force-recreate gateway` na sequência.

## Verificação

Após recriar o gateway, o container voltou a enxergar o socket e as requisições
chegaram ao broker. A instalação da unidade atualizada exige
`systemctl daemon-reload` e um último ciclo restart + recreate.
