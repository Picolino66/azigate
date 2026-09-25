/**
 * Divide um fluxo de bytes em linhas NDJSON. Linhas acima do limite são descartadas
 * inteiras (até o próximo `\n`) e reportadas, sem acumular memória sem limite.
 */
export class LineSplitter {
  private buffered: Buffer[] = []
  private bufferedBytes = 0
  private discarding = false

  constructor(
    private readonly maxLineBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onOversized: () => void,
  ) {}

  push(chunk: Buffer): void {
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start)
      const end = newline === -1 ? chunk.length : newline
      const piece = chunk.subarray(start, end)
      if (!this.discarding) {
        if (this.bufferedBytes + piece.length > this.maxLineBytes) {
          this.discarding = true
          this.buffered = []
          this.bufferedBytes = 0
          this.onOversized()
        } else if (piece.length > 0) {
          this.buffered.push(piece)
          this.bufferedBytes += piece.length
        }
      }
      if (newline === -1) return
      if (!this.discarding) this.emitBuffered()
      this.discarding = false
      this.buffered = []
      this.bufferedBytes = 0
      start = newline + 1
    }
  }

  /** Emite a última linha sem `\n` final, se houver. */
  flush(): void {
    if (!this.discarding) this.emitBuffered()
    this.buffered = []
    this.bufferedBytes = 0
    this.discarding = false
  }

  private emitBuffered(): void {
    if (this.bufferedBytes === 0) return
    const line = Buffer.concat(this.buffered, this.bufferedBytes).toString('utf8').replace(/\r$/u, '')
    if (line.trim().length > 0) this.onLine(line)
  }
}

export function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown
  } catch {
    return undefined
  }
}
