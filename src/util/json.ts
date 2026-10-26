/** Lossless JSON snapshot across the guest↔host boundary (dsh realm convention). */

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json }

export class MaterializeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MaterializeError'
  }
}

/**
 * Snapshot a value into lossless JSON. Top-level undefined, special prototypes,
 * functions, symbols, cycles, sparse arrays, non-finite numbers and nested
 * undefined are rejected (workflow-ptc realm.ts discipline). MaterializeError
 * is defined locally on purpose: this file must stay importable with zero
 * official-package value imports (guest/journal smoke dependency surface).
 */
export function snapshotJsonValue(value: unknown, depth = 0): Json {
  if (depth > 64) throw new MaterializeError('value nesting exceeds 64 levels')
  if (value === undefined) throw new MaterializeError('undefined is not lossless JSON')
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MaterializeError('non-finite number is not lossless JSON')
    return value
  }
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    throw new MaterializeError(`${typeof value} is not lossless JSON`)
  }
  if (Array.isArray(value)) {
    const out: Json[] = []
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new MaterializeError('sparse array is not lossless JSON')
      out.push(snapshotJsonValue(value[i], depth + 1))
    }
    return out
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    throw new MaterializeError('special prototype is not lossless JSON')
  }
  const record: Record<string, Json> = {}
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (member === undefined) throw new MaterializeError('nested undefined is not lossless JSON')
    record[key] = snapshotJsonValue(member, depth + 1)
  }
  return record
}
