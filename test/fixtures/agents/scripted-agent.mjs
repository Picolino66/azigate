// Núcleo compartilhado das CLIs falsas no modo "workspace remoto". Ele faz o papel do loop
// agentic: inicia o servidor MCP exatamente como a CLI real faria (comando/args/env vindos da
// configuração nativa de cada uma), chama ferramentas via JSON-RPC e produz um texto final.
// O roteiro vem no texto do turno: um array JSON de passos.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

export function startMcp({ command, args, env }) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let nextId = 1
  const pending = new Map()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    const waiter = pending.get(message.id)
    if (waiter) {
      pending.delete(message.id)
      waiter(message)
    }
  })
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const ready = request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } }).then(
    () => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`),
  )
  return {
    async list() {
      await ready
      return (await request('tools/list', {})).result?.tools ?? []
    },
    async call(name, args) {
      await ready
      const reply = await request('tools/call', { name, arguments: args })
      if (reply.error) return { ok: false, text: `erro de protocolo: ${reply.error.message}` }
      return { ok: reply.result?.isError !== true, text: reply.result?.content?.[0]?.text ?? '' }
    },
    close() {
      child.stdin.end()
      child.kill()
    },
  }
}

/**
 * Executa um roteiro. `hooks.permission(name, args)` modela o sistema de permissão nativo
 * (só o Claude pergunta antes; Codex e AGY deixam o Azigate decidir). `memory` sobrevive entre
 * turnos, como o contexto de uma sessão real.
 */
export async function runScript(steps, mcp, hooks, memory) {
  const lines = []
  for (const [index, step] of steps.entries()) {
    if (step.say) lines.push(step.say)
    if (step.recall) lines.push(`lembro: ${memory.lastRead ?? 'nada'}`)
    if (step.localCheck) lines.push(`local ${step.localCheck}: ${existsSync(step.localCheck) ? 'presente' : 'ausente'} em ${process.cwd()}`)
    if (step.hang) return { hang: true, lines }
    if (!step.call) continue
    const id = `call_${index}_${Date.now()}`
    hooks.started(step.call, step.args ?? {}, id)
    if (hooks.permission && !(await hooks.permission(step.call, step.args ?? {}, id))) {
      hooks.finished(step.call, id, false, 'negado pelo usuário')
      lines.push(`${step.call}: negado`)
      continue
    }
    const result = await mcp.call(step.call, step.args ?? {})
    if (step.call === 'read_file' && result.ok) memory.lastRead = result.text
    hooks.finished(step.call, id, result.ok, result.text)
    lines.push(`${step.call}: ${result.ok ? 'ok' : 'erro'} ${result.text}`)
  }
  return { hang: false, lines }
}

export function parseScript(text) {
  try {
    const steps = JSON.parse(text)
    return Array.isArray(steps) ? steps : undefined
  } catch {
    return undefined
  }
}
