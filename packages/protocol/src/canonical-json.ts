export type CanonicalJsonPrimitive = null | boolean | number | string
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue }

/**
 * Deterministically serializes JSON data for signing.
 *
 * Objects are sorted by UTF-16 property name, matching JSON.stringify's string
 * escaping and RFC 8785's ECMAScript number representation. Values which have
 * no unambiguous JSON representation are rejected instead of silently changed.
 */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>()

  const serialize = (current: unknown): string => {
    if (current === null) return 'null'

    switch (typeof current) {
      case 'boolean':
      case 'string':
        return JSON.stringify(current)
      case 'number':
        if (!Number.isFinite(current)) {
          throw new TypeError('Canonical JSON cannot encode non-finite numbers')
        }
        return JSON.stringify(current)
      case 'object': {
        const object = current as object
        if (ancestors.has(object)) {
          throw new TypeError('Canonical JSON cannot encode cyclic values')
        }
        ancestors.add(object)
        try {
          if (Array.isArray(current)) {
            const entries: string[] = []
            for (let index = 0; index < current.length; index += 1) {
              if (!(index in current)) {
                throw new TypeError('Canonical JSON cannot encode sparse arrays')
              }
              entries.push(serialize(current[index]))
            }
            return `[${entries.join(',')}]`
          }

          const prototype = Object.getPrototypeOf(current)
          if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError('Canonical JSON only accepts plain objects')
          }

          const record = current as Record<string, unknown>
          const entries = Object.keys(record)
            .sort()
            .map((key) => {
              if (record[key] === undefined) {
                throw new TypeError('Canonical JSON cannot encode undefined')
              }
              return `${JSON.stringify(key)}:${serialize(record[key])}`
            })
          return `{${entries.join(',')}}`
        } finally {
          ancestors.delete(object)
        }
      }
      default:
        throw new TypeError(`Canonical JSON cannot encode ${typeof current}`)
    }
  }

  return serialize(value)
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value))
}
