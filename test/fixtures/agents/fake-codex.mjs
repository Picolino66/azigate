#!/usr/bin/env node
// `codex app-server` falso para testes: JSON-RPC por stdio sem campo `jsonrpc`, como a CLI
// 0.144.6. O texto do turno escolhe o cenário: "comando" (pede aprovação), "trava", "falha".
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.argv[2] === '--version') {
  process.stdout.write('codex-cli 0.144.6\n')
  process.exit(0)
}
if (process.argv[2] === 'login') process.exit(1)
writeFileSync('.fake-argv.json', JSON.stringify(process.argv.slice(2)))
const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)
let threadId
let turnId
let approvalRequestId
let serverRequestSeq = 100
let lastThreadParams

function notify(method, params) {
  send({ method, params })
}

function completeTurn(status) {
  notify('thread/tokenUsage/updated', {
    threadId,
    turnId,
    tokenUsage: {
      total: { totalTokens: 50, inputTokens: 30, cachedInputTokens: 10, outputTokens: 20, reasoningOutputTokens: 5 },
      last: { totalTokens: 50, inputTokens: 30, cachedInputTokens: 10, outputTokens: 20, reasoningOutputTokens: 5 },
      modelContextWindow: null,
    },
  })
  notify('turn/completed', { threadId, turn: { id: turnId, items: [], status, error: null } })
}

function agentMessage(text) {
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg_1', delta: text })
  notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'msg_1', text }, completedAtMs: 0 })
}

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake', codexHome: '/tmp/fake', platformFamily: 'unix', platformOs: 'linux' } })
    return
  }
  if (message.method === 'initialized') return
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    lastThreadParams = message.params
    writeFileSync('.fake-thread-params.json', JSON.stringify({ method: message.method, params: message.params }))
    if (message.method === 'thread/resume' && message.params.threadId === 'inexistente') {
      send({ id: message.id, error: { code: -32000, message: 'thread not found' } })
      return
    }
    threadId = message.method === 'thread/resume' ? message.params.threadId : 'thread-0001'
    send({ id: message.id, result: { thread: { id: threadId }, model: message.params.model ?? 'gpt-fake', cwd: message.params.cwd } })
    return
  }
  if (message.method === 'turn/start') {
    turnId = `turn-${Date.now()}`
    send({ id: message.id, result: { turn: { id: turnId, items: [], status: 'inProgress', error: null } } })
    notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } })
    const text = message.params.input[0].text
    if (text === 'trava') return
    if (text === 'falha') {
      completeTurn('failed')
      return
    }
    if (text === 'desconhecido') {
      send({ id: serverRequestSeq++, method: 'item/tool/requestUserInput', params: { threadId, turnId } })
      agentMessage('seguindo')
      completeTurn('completed')
      return
    }
    if (text === 'comando') {
      notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: 'cmd_1', command: 'npm test', status: 'inProgress' }, startedAtMs: 0 })
      approvalRequestId = serverRequestSeq++
      send({
        id: approvalRequestId,
        method: 'item/commandExecution/requestApproval',
        params: { threadId, turnId, itemId: 'cmd_1', startedAtMs: 0, environmentId: null, command: 'npm test', cwd: lastThreadParams?.cwd },
      })
      return
    }
    notify('item/reasoning/textDelta', { threadId, turnId, itemId: 'r_1', delta: 'pensando' })
    agentMessage('Feito')
    completeTurn('completed')
    return
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} })
    completeTurn('interrupted')
    return
  }
  if (message.id === approvalRequestId && 'result' in message) {
    const accepted = message.result.decision === 'accept'
    notify('item/completed', {
      threadId,
      turnId,
      item: { type: 'commandExecution', id: 'cmd_1', command: 'npm test', status: accepted ? 'completed' : 'declined' },
      completedAtMs: 0,
    })
    agentMessage(accepted ? 'comando executado' : 'comando recusado')
    completeTurn('completed')
    return
  }
  if (message.id !== undefined && 'error' in message) {
    writeFileSync('.fake-last-error.json', JSON.stringify(message))
  }
})
