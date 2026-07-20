# Sessões CLI efêmeras em memória

## Descrição

Reduz o reenvio de contexto em conversas Codex/Claude sem tornar o gateway HTTP
stateful e sem persistir transcripts. O broker mantém processos/threads temporários
e somente hashes de correlação em RAM.

## Localização no código

- `src/broker/memory-executor.ts`: sessões, App Server Codex e Claude stream-json;
- `src/broker/session-correlation.ts`: fingerprint e hashes semânticos;
- `src/broker/interactive-process.ts`: processo JSONL persistente e cancelamento;
- `src/broker/prompt.ts`: prefixo fixo e delta variável;
- `src/broker/executor.ts`: seleção entre `memory` e `stateless`.

## Entrada

O mesmo request fechado do protocolo v6: provider, modelo, effort, mensagens
textuais, function tools, `toolChoice` e `parallelToolCalls`. O cliente não fornece
session ID, hash, cwd, path, comando, argv ou ambiente.

## Saída

Decisão validada, usage provider-specific e:

```json
{
  "sessionMode": "memory",
  "sessionReused": true,
  "transcriptBytes": 8192
}
```

Esses metadados ficam no protocolo privado/logs; a resposta pública continua
OpenAI Compatible.

## Dependências

Unix socket privado, Bubblewrap, auth files privados, Codex App Server, Claude
`--input-format stream-json --output-format stream-json` e protocolo v6 implantado
coordenadamente no broker/gateway.

## Regras de negócio

- primeiro turno envia o transcript completo; seguintes enviam somente o delta;
- reuso exige exatamente uma sessão cujo hash seja prefixo completo da entrada;
- IDs de tool calls são normalizados por ordem antes do SHA-256;
- tools/modelo fazem parte do fingerprint; effort faz parte para Claude;
- Codex aceita troca de effort no turno; Claude cria sessão nova;
- TTL, LRU, crash, cancelamento, eviction e restart eliminam estado;
- no máximo quatro sessões por padrão, com concorrência de inferência global 1;
- nenhum transcript ou hash é gravado em disco ou log;
- transcript acima de 256 KiB recebe `413`, nunca truncamento;
- qualquer evento local de shell, arquivo, MCP, hook, app ou subagente encerra a
  sessão com erro seguro.

## Fluxo resumido

Normalizar request -> calcular fingerprint/hashes -> eliminar sessões expiradas ->
localizar um único prefixo -> criar/reutilizar handle -> enviar full/delta ->
validar eventos/decisão/usage -> atualizar hashes esperados -> responder.

## Possíveis erros

`cli_context_too_large`, `cli_busy`, `cli_timeout`, `invalid_cli_output`,
`cli_execution_failed` e `cli_unavailable`. Falha de um provider nunca provoca
fallback para outro; o operador pode definir somente esse provider como
`stateless` durante rollback.
