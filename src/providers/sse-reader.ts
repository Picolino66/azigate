import type { ReadableStream } from 'node:stream/web'

export interface SseEvent {
  event?: string
  data: string
}

/**
 * Buffer de linha generoso (50 MB): eventos com imagem em base64 podem
 * estourar qualquer default menor e quebrar o leitor linha a linha (Seção 6.5).
 */
const MAX_BUFFER_BYTES = 50 * 1024 * 1024

export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  let eventName: string | undefined
  let dataLines: string[] = []

  const flush = function* (): Generator<SseEvent> {
    if (dataLines.length > 0) {
      yield { ...(eventName === undefined ? {} : { event: eventName }), data: dataLines.join('\n') }
    }
    eventName = undefined
    dataLines = []
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > MAX_BUFFER_BYTES) buffer = ''

      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const rawLine = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

        if (line === '') {
          yield* flush()
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trimStart()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart())
        }
        newlineIndex = buffer.indexOf('\n')
      }
    }
    yield* flush()
  } finally {
    reader.releaseLock()
  }
}
