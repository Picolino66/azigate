import type { DestinationStream } from 'pino'

const RESET = '\x1b[0m'
const MODEL_COLORS = new Map<string, string>([
  ['deepseek-v4-flash', '\x1b[32m'],
  ['deepseek-v4-pro', '\x1b[34m'],
  ['codex-cli', '\x1b[31m'],
  ['codex-cli-sol', '\x1b[31m'],
  ['codex-cli-terra', '\x1b[31m'],
  ['codex-cli-luna', '\x1b[31m'],
  ['codex-cli-5.5', '\x1b[31m'],
  ['codex-cli-5.4', '\x1b[31m'],
])

export function colorizeModelLogLine(line: string): string {
  let colored = line
  for (const [model, color] of MODEL_COLORS) {
    colored = colored.replaceAll(`"model":"${model}"`, `"model":"${color}${model}${RESET}"`)
  }
  return colored
}

export function createColorizedStdoutDestination(): DestinationStream {
  return {
    write(line: string): void {
      process.stdout.write(colorizeModelLogLine(line))
    },
  }
}
