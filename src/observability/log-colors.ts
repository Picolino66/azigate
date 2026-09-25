import type { DestinationStream } from 'pino'

const RESET = '\x1b[0m'
export const MODEL_LOG_COLORS: Readonly<Record<string, string>> = {
  'deepseek-v4-flash': '\x1b[32m',
  'deepseek-v4-pro': '\x1b[34m',
  'codex-cli': '\x1b[31m',
  'codex-cli-sol': '\x1b[91m',
  'codex-cli-terra': '\x1b[35m',
  'codex-cli-luna': '\x1b[33m',
  'codex-cli-5.5': '\x1b[36m',
  'codex-cli-5.4': '\x1b[95m',
  'claude-cli': '\x1b[38;5;214m',
  'claude-cli-opus-5.5': '\x1b[92m',
  'claude-cli-opus-5': '\x1b[38;5;208m',
  'claude-cli-fable-5.1': '\x1b[96m',
  'claude-cli-sonnet-5': '\x1b[93m',
  'claude-cli-haiku-4.5': '\x1b[38;5;141m',
}

export function colorizeModelLogLine(line: string): string {
  return line.replace(/("model":")([^"\\]+)(")/gu, (match, prefix: string, model: string, suffix: string) => {
    const color = MODEL_LOG_COLORS[model]
    return color === undefined ? match : `${prefix}${color}${model}${RESET}${suffix}`
  })
}

export function createColorizedStdoutDestination(): DestinationStream {
  return {
    write(line: string): void {
      process.stdout.write(colorizeModelLogLine(line))
    },
  }
}
