#!/usr/bin/env node
// Claude Code falso para testes: emula `-p --input-format stream-json --output-format stream-json`
// com o protocolo de controle. Grava argv em `.fake-argv.json` no cwd. O comportamento de cada
// turno depende do texto recebido: "ferramenta", "falha", "trava", "morre" ou qualquer outro.
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.argv[2] === '--version') {
  process.stdout.write('2.1.280 (Claude Code)\n')
  process.exit(0)
}
if (process.argv[2] === 'auth') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
  process.exit(0)
}
writeFileSync('.fake-argv.json', JSON.stringify(process.argv.slice(2)))
const args = process.argv.slice(2)
const sessionFlag = args.indexOf('--session-id') >= 0 ? args.indexOf('--session-id') : args.indexOf('--resume')
const sessionId = args[sessionFlag + 1] ?? 'desconhecida'
if (args.includes('--resume') && sessionId === 'inexistente') {
  process.stderr.write('No conversation found\n')
  process.exit(1)
}
const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)
let pendingPermission
let hanging = false

function result(subtype, text) {
  send({
    type: 'result',
    subtype,
    is_error: subtype !== 'success',
    result: text,
    session_id: sessionId,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 7 },
  })
}

function runTurn(text) {
  send({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-fake-1', tools: [], cwd: process.cwd() })
  if (text === 'morre') process.exit(3)
  if (text === 'trava') {
    hanging = true
    return
  }
  if (text === 'falha') {
    result('error_during_execution', undefined)
    return
  }
  if (text === 'ferramenta') {
    send({
      type: 'assistant',
      parent_tool_use_id: null,
      session_id: sessionId,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] },
    })
    pendingPermission = 'perm_1'
    send({
      type: 'control_request',
      request_id: 'perm_1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' }, tool_use_id: 'toolu_1' },
    })
    return
  }
  send({
    type: 'stream_event',
    parent_tool_use_id: null,
    session_id: sessionId,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Olá ' } },
  })
  send({
    type: 'stream_event',
    parent_tool_use_id: null,
    session_id: sessionId,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'mundo' } },
  })
  send({
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Olá mundo' }] },
  })
  result('success', 'Olá mundo')
}

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const subtype = message.request?.subtype
    if (subtype === 'initialize') {
      send({
        type: 'control_response',
        response: { subtype: 'success', request_id: message.request_id, response: { account: { email: 'segredo@example.com' } } },
      })
    } else if (subtype === 'interrupt') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } })
      if (hanging) {
        hanging = false
        result('error_during_execution', undefined)
      }
    }
    return
  }
  if (message.type === 'control_response' && message.response?.request_id === pendingPermission) {
    pendingPermission = undefined
    const allowed = message.response.response?.behavior === 'allow'
    send({
      type: 'user',
      parent_tool_use_id: null,
      session_id: sessionId,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: !allowed, content: allowed ? 'ok' : 'negado' }] },
    })
    result('success', allowed ? 'ferramenta executada' : 'ferramenta negada')
    return
  }
  if (message.type === 'user') runTurn(message.message.content[0].text)
})
