import { randomBytes } from 'node:crypto'

type IdPrefix = 'agt' | 'trn' | 'apr' | 'rpc'

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`
}

export function isId(prefix: IdPrefix, value: string): boolean {
  return new RegExp(`^${prefix}_[a-f0-9]{24}$`, 'u').test(value)
}
