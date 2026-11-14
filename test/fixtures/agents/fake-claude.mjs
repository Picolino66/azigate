#!/usr/bin/env node
// Claude Code falso para testes: emula `-p --input-format stream-json --output-format stream-json`
// com o protocolo de controle. Grava argv em `.fake-argv.json` no cwd. Turnos em texto usam
// cenários fixos ("ferramenta", "falha", "trava", "morre"); turnos com um array JSON executam
// um roteiro contra o MCP de `--mcp-config`, como o Claude real faria.
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { parseScript, runScript, startMcp } from './scripted-agent.mjs'

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
const flagValue = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined)
const sessionId = flagValue('--session-id') ?? flagValue('--resume') ?? 'desconhecida'
if (args.includes('--resume') && sessionId === 'inexistente') {
  process.stderr.write('No conversation found\n')
  process.exit(1)
}
const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)
const permissionWaiters = new Map()
let pendingPermission
let hanging = false
let permissionSeq = 0
const memory = {}

let mcp
const mcpConfigPath = flagValue('--mcp-config')
if (mcpConfigPath) {
  const server = Object.entries(JSON.parse(readFileSync(mcpConfigPath, 'utf8')).mcpServers)[0]
  mcp = { name: server[0], client: startMcp(server[1]) }
}
const allowed = new Set((flagValue('--allowedTools') ?? '').split(',').filter(Boolean))

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

async function runRemote(steps) {
  if (!mcp) {
    result('error_during_execution', 'sem MCP')
    return
  }
  const toolName = (call) => `mcp__${mcp.name}__${call}`
  const outcome = await runScript(steps, mcp.client, {
    started: (call, input, id) =>
      send({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: toolName(call), input }] } }),
    permission: (call, input, id) => {
      if (allowed.has(toolName(call))) return Promise.resolve(true)
      const requestId = `perm_${++permissionSeq}`
      send({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: toolName(call), input, tool_use_id: id } })
      return new Promise((resolve) => permissionWaiters.set(requestId, resolve))
    },
    finished: (_call, id, ok, text) =>
      send({ type: 'user', parent_tool_use_id: null, session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !ok, content: text }] } }),
  }, memory)
  if (outcome.hang) {
    hanging = true
    return
  }
  const text = outcome.lines.join('\n')
  send({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text }] } })
  result('success', text)
}

function runTurn(text) {
  send({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-fake-1', tools: [], cwd: process.cwd() })
  const script = parseScript(text)
  if (script) {
    void runRemote(script)
    return
  }
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
  if (message.type === 'control_response') {
    const requestId = message.response?.request_id
    const allowedByUser = message.response?.response?.behavior === 'allow'
    const waiter = permissionWaiters.get(requestId)
    if (waiter) {
      permissionWaiters.delete(requestId)
      waiter(allowedByUser)
      return
    }
    if (requestId === pendingPermission) {
      pendingPermission = undefined
      send({
        type: 'user',
        parent_tool_use_id: null,
        session_id: sessionId,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: !allowedByUser, content: allowedByUser ? 'ok' : 'negado' }] },
      })
      result('success', allowedByUser ? 'ferramenta executada' : 'ferramenta negada')
    }
    return
  }
  if (message.type === 'user') runTurn(message.message.content[0].text)
})
input.on('close', () => mcp?.client.close())
