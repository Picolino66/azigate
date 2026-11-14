#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { AgentApi } from './api.js'
import { USAGE, parseChatArgs } from './args.js'
import { ChatController, type ChatOptions } from './chat.js'
import { resolveClientSettings, type ClientSettings } from './settings.js'

// azigate-agent: cliente de terminal do Native Agent Plane (roda na máquina B, ou onde quiser).
//   azigate-agent chat <claude|codex|agy> <workspace> [opções]
//   azigate-agent providers | workers
function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

let settings: ClientSettings
try {
  settings = resolveClientSettings()
} catch (error) {
  fail(error instanceof Error ? error.message : 'configuração local inválida')
}

function readKey(): string {
  if (!settings.key) {
    fail('Defina AZIGATE_AGENT_KEY, AZIGATE_AGENT_KEY_FILE ou agent.key na pasta de configuração (uma das AGENT_API_KEYS da máquina A).')
  }
  return settings.key
}

const [command, ...args] = process.argv.slice(2)
const api = new AgentApi(settings.url, command === undefined ? '' : readKey())

switch (command) {
  case 'providers':
    process.stdout.write(`${JSON.stringify(await api.providers(), null, 2)}\n`)
    break
  case 'workers':
    process.stdout.write(`${JSON.stringify(await api.workers(), null, 2)}\n`)
    break
  case 'chat': {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY })
    const lines: string[] = []
    const waiters: ((line: string | null) => void)[] = []
    let ended = false
    rl.on('line', (line) => {
      const waiter = waiters.shift()
      if (waiter) waiter(line)
      else lines.push(line)
    })
    rl.on('close', () => {
      ended = true
      for (const waiter of waiters.splice(0)) waiter(null)
    })
    let interruptHandler: () => void = () => process.exit(130)
    rl.on('SIGINT', () => interruptHandler())
    process.on('SIGINT', () => interruptHandler())
    let options: ChatOptions
    try {
      options = parseChatArgs(args)
    } catch (error) {
      fail(error instanceof Error ? error.message : USAGE)
    }
    const controller = new ChatController(
      api,
      {
        write: (text) => process.stdout.write(text),
        ask: (prompt) => {
          process.stdout.write(prompt)
          const queued = lines.shift()
          if (queued !== undefined) return Promise.resolve(queued)
          if (ended) return Promise.resolve(null)
          return new Promise((resolve) => waiters.push(resolve))
        },
        onInterrupt: (handler) => {
          interruptHandler = handler
        },
      },
      options,
    )
    const code = await controller.run()
    rl.close()
    process.exit(code)
    break
  }
  default:
    fail(USAGE)
}
