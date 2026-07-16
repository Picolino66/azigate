import { createHash, timingSafeEqual } from 'node:crypto'

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export class GatewayAuthenticator {
  private readonly keys: readonly { digest: Buffer; id: string }[]

  constructor(keys: readonly string[]) {
    this.keys = keys.map((key) => {
      const keyDigest = digest(key)
      return { digest: keyDigest, id: keyDigest.toString('hex').slice(0, 12) }
    })
  }

  verify(header: string | undefined): string | undefined {
    const match = /^Bearer[ \t]+(.+)$/iu.exec(header ?? '')
    const candidate = digest(match?.[1]?.trim() ?? '')
    let matchedIndex = -1
    for (let index = 0; index < this.keys.length; index += 1) {
      const configured = this.keys[index]
      if (configured && timingSafeEqual(candidate, configured.digest)) matchedIndex = index
    }
    return match && matchedIndex >= 0 ? this.keys[matchedIndex]?.id : undefined
  }
}
