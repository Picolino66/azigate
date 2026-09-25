#!/usr/bin/env node
// AGY falso para testes: `init` no startup, uma linha `{"event":"user"}` por turno e `result`.
// Emula o comportamento real de `--conversation` com ID inexistente: cria conversa nova.
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.argv[2] === '--version') {
  process.stdout.write('1.2.10\n')
  process.exit(0)
}
if (process.argv[2] === '-p=/model') {
  process.stdout.write(JSON.stringify({ conversation_id: '', status: 'SUCCESS', response: 'modelo' }))
  process.exit(0)
}
writeFileSync('.fake-argv.json', JSON.stringify(process.argv.slice(2)))
const args = process.argv.slice(2)
const flag = args.indexOf('--conversation')
const requested = flag >= 0 ? args[flag + 1] : undefined
const conversationId = requested && requested !== 'inexistente' ? requested : 'conv-nova-0001'
const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)
let hanging = false

function result(status, response, error) {
  send({
    event: 'result',
    result: {
      conversation_id: conversationId,
      status,
      response,
      error,
      duration_seconds: 1,
      num_turns: 1,
      usage: { input_tokens: 20, output_tokens: 8, thinking_tokens: 3, cache_read_tokens: 4, total_tokens: 28 },
    },
  })
}

process.on('SIGINT', () => {
  if (hanging) result('ERROR', '', 'interrompido')
  process.exit(130)
})

setTimeout(() => {
  send({ event: 'init', conversation_id: conversationId, init: { cwd: process.cwd(), tools: ['run_command'], permission_mode: 'request-review' } })
}, 20)

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.event !== 'user') return
  const text = message.message.content
  if (text === 'trava') {
    hanging = true
    return
  }
  if (text === 'falha') {
    result('ERROR', '', 'falha do agente')
    return
  }
  send({ event: 'step_update', step_update: { step_index: 1, step_type: 'RUN_COMMAND', status: 'RUNNING', tool_info: { name: 'run_command' } } })
  send({ event: 'step_update', step_update: { step_index: 1, step_type: 'RUN_COMMAND', status: 'DONE', tool_info: { name: 'run_command', output: 'ok' } } })
  send({ event: 'step_update', step_update: { step_index: 2, step_type: 'INVOKE_SUBAGENT', status: 'RUNNING', subagent_info: { conversation_id: 'filho-1' } } })
  send({ event: 'step_update', step_update: { step_index: 2, step_type: 'INVOKE_SUBAGENT', status: 'DONE', subagent_info: { conversation_id: 'filho-1' } } })
  send({ event: 'step_update', step_update: { step_index: 3, step_type: 'PLANNER_RESPONSE', status: 'DONE' } })
  result('SUCCESS', 'Pronto', '')
})
