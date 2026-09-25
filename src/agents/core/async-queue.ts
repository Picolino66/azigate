/** Fila assíncrona simples: produtores empurram itens, um único consumidor itera. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private waiting: ((result: IteratorResult<T>) => void) | undefined
  private ended = false

  push(item: T): void {
    if (this.ended) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve({ value: item, done: false })
      return
    }
    this.items.push(item)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve({ value: undefined, done: true })
    }
  }

  get isEnded(): boolean {
    return this.ended
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
      return: () => {
        this.end()
        this.items.length = 0
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}
