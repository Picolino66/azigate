#!/usr/bin/env node
// AGY falso para testes: `init` no startup, uma linha `{"event":"user"}` por turno e `result`.
// Emula o comportamento real de `--conversation` com ID inexistente: cria conversa nova.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseScript, runScript, startMcp } from './scripted-agent.mjs'

const home = process.env.HOME ?? '/nao-definido'
const mcpConfigFile = join(home, '.gemini', 'config', 'mcp_config.json')
const readJson = (path) => (existsSync(path) && readFileSync(path, 'utf8').trim() ? JSON.parse(readFileSync(path, 'utf8')) : {})
if (process.argv[2] === 'mcp') {
  const config = readJson(mcpConfigFile)
  config.mcpServers ??= {}
  if (process.argv[3] === 'add') {
    const rest = process.argv.slice(4)
    const name = rest[0]
    const command = rest[1] === '--' ? rest.slice(2) : rest.slice(1)
    config.mcpServers[name] = { command: command[0], args: command.slice(1) }
  } else if (process.argv[3] === 'remove') {
    delete config.mcpServers[process.argv[4]]
  }
  mkdirSync(dirname(mcpConfigFile), { recursive: true })
  writeFileSync(mcpConfigFile, JSON.stringify(config))
  process.exit(0)
}

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
const agentFlag = args.indexOf('--agent') >= 0 ? args[args.indexOf('--agent') + 1] : undefined
const agentFile = agentFlag ? join(home, '.gemini', 'config', 'agents', `${agentFlag}.md`) : undefined
const remoteAgent = agentFile !== undefined && existsSync(agentFile) && readFileSync(agentFile, 'utf8').includes('excludeDefaultComponents: true')
const server = readJson(mcpConfigFile).mcpServers?.azigate_workspace
// Servidores MCP globais sobem no startup e herdam o ambiente do processo (comportamento real).
const mcp = remoteAgent && server ? startMcp({ command: server.command, args: server.args, env: {} }) : undefined
const allowRules = new Set(readJson(join(home, '.gemini', 'antigravity-cli', 'settings.json')).permissions?.allow ?? [])
const memory = {}
let stepIndex = 10

async function runRemote(steps) {
  if (!mcp) {
    result('ERROR', '', 'agente remoto ou servidor MCP ausente')
    return
  }
  const outcome = await runScript(steps, mcp, {
    started: (call, callArgs, id) => {
      stepIndex += 1
      stepIds[id] = stepIndex
      send({ event: 'step_update', step_update: { conversation_id: conversationId, step_index: stepIndex, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters: { Arguments: callArgs, ServerName: 'azigate_workspace', ToolName: call } } } })
    },
    // Headless: sem regra mcp(<servidor>/<ferramenta>) em permissions.allow, a chamada é negada.
    permission: (call) => Promise.resolve(allowRules.has(`mcp(azigate_workspace/${call})`)),
    finished: (call, id, ok, text) =>
      send({ event: 'step_update', step_update: { conversation_id: conversationId, step_index: stepIds[id], state: ok ? 'DONE' : 'ERROR', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters: { ServerName: 'azigate_workspace', ToolName: call }, ...(ok ? {} : { error: { type: 'TOOL_ERROR', message: text } }) } } }),
  }, memory)
  if (outcome.hang) {
    hanging = true
    return
  }
  result('SUCCESS', outcome.lines.join('\n'), '')
}
const stepIds = {}

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
  const script = parseScript(text)
  if (script) {
    void runRemote(script)
    return
  }
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

input.on('close', () => mcp?.close())
