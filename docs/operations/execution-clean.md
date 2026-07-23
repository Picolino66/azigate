# Execução limpa do broker e gateway Docker

## Descrição

Este runbook reinicia de forma controlada o broker host e o gateway Docker a
partir do checkout atual. Ele não lê, imprime, altera ou copia `.env`, credenciais
Codex/Claude ou arquivos de `secrets/`.

## Pré-requisitos

- Execute os comandos como o usuário que possui o checkout e o login do Codex.
- A unidade usada neste projeto é `azigate-broker@isaiasgr.service`; troque
  somente o nome de usuário se a sua instalação usar outro.
- Aguarde uma execução Qwen em andamento terminar antes de parar o broker.

## 1. Parada controlada

No diretório do projeto, pare somente os containers deste Compose. A operação não
remove volumes, imagens, credenciais nem o diretório do projeto.

```bash
cd "/home/isaiasgr/Área de trabalho/Projetos/github/gateway-ai"
docker compose down --remove-orphans
sudo systemctl stop azigate-broker@isaiasgr.service
sudo systemctl reset-failed azigate-broker@isaiasgr.service
```

Confirme que não há containers do Compose em execução e que a unidade parou:

```bash
docker compose ps --all
systemctl is-active azigate-broker@isaiasgr.service
```

O segundo comando deve retornar `inactive` nesse ponto.

## 2. Build e instalação reproduzível do broker

Instale as dependências a partir do lockfile, execute todos os gates e publique
somente `dist/` e a unidade systemd. O `--delete` é limitado a
`/opt/azigate/dist/`, destino oficial de artefatos gerados.

```bash
npm ci --ignore-scripts
npm run check
npm run test:coverage
npm audit --omit=dev --audit-level=high
systemd-analyze verify config/systemd/azigate-broker@.service

sudo install -d -m 0755 /opt/azigate
sudo rsync -a --delete dist/ /opt/azigate/dist/
sudo install -m 0644 package.json /opt/azigate/package.json
sudo install -m 0644 config/systemd/azigate-broker@.service \
  /etc/systemd/system/azigate-broker@.service
```

Não copie o repositório inteiro para `/opt/azigate` e não monte o home, o
repositório ou o socket Docker no container.

## 3. Início e validação do broker

```bash
sudo systemctl daemon-reload
sudo systemctl start azigate-broker@isaiasgr.service
systemctl is-active azigate-broker@isaiasgr.service
curl --fail --unix-socket /run/azigate/broker.sock http://localhost/health
stat -c '%a %U:%G %n' /run/azigate /run/azigate/broker.sock
```

Espere `active`, um health com protocolo `6` e o socket com permissão `0600`.
Se o health não estiver pronto, pare aqui: não inicie o gateway com aliases CLI
até resolver a indisponibilidade.

## 4. Início limpo do gateway Docker

Com o broker saudável, valide a configuração sem mostrá-la e recrie apenas o
serviço gateway:

```bash
docker compose config --quiet
docker compose up -d --build --force-recreate gateway
docker compose ps
curl --fail http://127.0.0.1:3000/health
curl --fail http://127.0.0.1:3000/ready
```

`/ready` deve retornar sucesso antes de usar o Qwen. O gateway continua sem
acesso aos diretórios de autenticação do Codex/Claude.

## 5. Smoke do Qwen e observabilidade segura

Faça uma única requisição curta pelo Qwen com `codex-cli-terra` e tools
habilitadas. Não repita automaticamente uma falha. Em outro terminal, acompanhe
somente os metadados sanitizados:

```bash
sudo tail -f /run/azigate/logs/executions.jsonl
sudo journalctl -fu azigate-broker@isaiasgr.service
docker compose logs -f gateway
```

Uma execução bem-sucedida registra, nesta ordem, `received`,
`provider_dispatch_started`, `workspace_prepared`, `provider_turn_started`,
`provider_turn_finished`, `decision_validated` e `completed`.

Se houver falha, anote somente `requestId` e `reason` sanitizada. O broker já
aguarda uma notificação `error` com `willRetry: true`; `codex_turn_error_event`
indica que o App Server encerrou o turno sem nova tentativa. Não registre a
resposta RPC, prompt, tool arguments ou stderr bruto.

## 6. Encerramento seguro

Para parar o ambiente depois da validação:

```bash
docker compose down --remove-orphans
sudo systemctl stop azigate-broker@isaiasgr.service
```

Isso não remove imagens, volumes, `/etc/azigate/broker.env`, autenticação CLI ou
qualquer dado do usuário.
