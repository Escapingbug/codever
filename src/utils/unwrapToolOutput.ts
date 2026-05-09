/**
 * Priority-ordered field names for recursive extraction.
 * When an object has multiple string fields, the first match in this list wins.
 */
const EXTRACTION_PRIORITY = [
    'stdout', 'stderr', 'output', 'content', 'text', 'message', 'result',
] as const

function extractByPriority(
    obj: Record<string, unknown>,
    depth: number,
    visited: Set<unknown>,
): string {
    for (const key of EXTRACTION_PRIORITY) {
        const val = obj[key]
        if (val == null) continue
        if (typeof val === 'string') {
            if (val.trim() !== '') return val
            continue
        }
        if (typeof val === 'object' && depth < 3 && !visited.has(val)) {
            const nested = tryUnwrapObject(val as Record<string, unknown>, depth + 1, visited)
            if (nested !== '') return nested
        }
    }
    return ''
}

function tryUnwrapObject(
    obj: Record<string, unknown>,
    depth: number,
    visited: Set<unknown>,
): string {
    if (Array.isArray(obj)) return ''
    if (visited.has(obj)) return ''
    visited.add(obj)
    if (Object.keys(obj).length === 0) return ''
    const extracted = extractByPriority(obj, depth, visited)
    if (extracted !== '') return extracted
    for (const val of Object.values(obj)) {
        if (val == null || typeof val !== 'object' || Array.isArray(val) || visited.has(val)) continue
        const nested = extractByPriority(val as Record<string, unknown>, depth, visited)
        if (nested !== '') return nested
    }
    try {
        return JSON.stringify(obj)
    } catch {
        return ''
    }
}

export function unwrapToolOutput(raw: string | Record<string, unknown>): string {
    if (raw == null) return ''

    if (typeof raw === 'string') {
        if (!raw || !raw.trim().startsWith('{')) return raw

        try {
            const parsed = JSON.parse(raw)
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return raw

            const visited = new Set<unknown>()
            visited.add(parsed)
            const extracted = extractByPriority(parsed, 0, visited)
            if (extracted !== '') return extracted
            return ''
        } catch {
            return raw
        }
    }

    if (typeof raw === 'object' && raw !== null) {
        if (Array.isArray(raw)) return JSON.stringify(raw)
        const visited = new Set<unknown>()
        visited.add(raw)
        const extracted = extractByPriority(raw, 0, visited)
        if (extracted !== '') return extracted
        if (Object.keys(raw).length === 0) return ''
        try {
            return JSON.stringify(raw)
        } catch {
            return ''
        }
    }

    return String(raw)
}
