import type { HasMapping } from './types.js'

export function canonicalMapping(mapping: HasMapping): HasMapping {
    return Object.fromEntries(
        Object.entries(mapping)
            .map(([pseudonym, originals]) => [
                pseudonym.trim(),
                [...new Set(originals.map(value => value.trim()).filter(Boolean))].sort(),
            ] as const)
            .filter(([pseudonym, originals]) => pseudonym && originals.length > 0)
            .sort(([left], [right]) => left.localeCompare(right)),
    )
}

export function mergeMappings(base: HasMapping, delta: HasMapping): HasMapping {
    const result: Record<string, readonly string[]> = { ...canonicalMapping(base) }
    const ownerByOriginal = new Map<string, string>()
    for (const [pseudonym, originals] of Object.entries(result)) {
        for (const original of originals) ownerByOriginal.set(original, pseudonym)
    }
    for (const [pseudonym, originals] of Object.entries(canonicalMapping(delta))) {
        const existing = result[pseudonym] ?? []
        if (existing.length > 0 && originals.some(value => !existing.includes(value))) {
            throw new Error('Mapping pseudonym collision')
        }
        for (const original of originals) {
            const owner = ownerByOriginal.get(original)
            if (owner !== undefined && owner !== pseudonym) {
                throw new Error('Mapping original-value collision')
            }
            ownerByOriginal.set(original, pseudonym)
        }
        result[pseudonym] = [...new Set([...existing, ...originals])]
    }
    return canonicalMapping(result)
}

export function restoreText(text: string, mapping: HasMapping): string {
    let restored = text
    for (const [pseudonym, originals] of Object.entries(canonicalMapping(mapping))
        .sort(([left], [right]) => right.length - left.length)) {
        const original = originals[0]
        if (original !== undefined) restored = restored.split(pseudonym).join(original)
    }
    return restored
}

export function mappingFindingCount(text: string, mapping: HasMapping): number {
    return Object.keys(mapping).reduce((count, pseudonym) =>
        count + Math.max(0, text.split(pseudonym).length - 1), 0)
}
