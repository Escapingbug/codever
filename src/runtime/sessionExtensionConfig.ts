import { HttpSessionExtensionProvider } from './httpSessionExtension'
import { SessionExtensionRegistry } from './sessionExtensions'

export const SESSION_EXTENSIONS_ENV = 'CODEVER_SESSION_EXTENSIONS_JSON'

interface HttpExtensionConfig {
    endpoint: string
    bearerToken: string
    expectedExtensionId?: string
    timeoutMs?: number
}

/**
 * Loads administrator-owned extension process registrations. This is local
 * Gateway configuration and is never accepted from a PWA or Matrix command.
 */
export async function createSessionExtensionRegistryFromEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
): Promise<SessionExtensionRegistry> {
    const source = environment[SESSION_EXTENSIONS_ENV]
    if (!source?.trim()) return new SessionExtensionRegistry()

    let parsed: unknown
    try {
        parsed = JSON.parse(source)
    } catch {
        throw new Error(`${SESSION_EXTENSIONS_ENV} must contain valid JSON`)
    }
    if (!Array.isArray(parsed)) {
        throw new Error(`${SESSION_EXTENSIONS_ENV} must contain a JSON array`)
    }

    const providers = await Promise.all(parsed.map(async (value, index) => {
        const config = parseHttpExtensionConfig(value, index)
        return await HttpSessionExtensionProvider.connect(config)
    }))
    return new SessionExtensionRegistry(providers)
}

function parseHttpExtensionConfig(value: unknown, index: number): HttpExtensionConfig {
    const record = asRecord(value)
    if (!record) throw invalidConfig(index)
    const allowed = new Set(['endpoint', 'bearerToken', 'expectedExtensionId', 'timeoutMs'])
    if (Object.keys(record).some(key => !allowed.has(key))) throw invalidConfig(index)
    if (typeof record.endpoint !== 'string' || !record.endpoint.trim()) throw invalidConfig(index)
    if (typeof record.bearerToken !== 'string' || !record.bearerToken.trim()) throw invalidConfig(index)
    if (
        record.expectedExtensionId !== undefined
        && (typeof record.expectedExtensionId !== 'string' || !record.expectedExtensionId.trim())
    ) throw invalidConfig(index)
    if (
        record.timeoutMs !== undefined
        && (!Number.isSafeInteger(record.timeoutMs) || Number(record.timeoutMs) <= 0)
    ) {
        throw invalidConfig(index)
    }
    return {
        endpoint: record.endpoint,
        bearerToken: record.bearerToken,
        ...(record.expectedExtensionId === undefined
            ? {}
            : { expectedExtensionId: record.expectedExtensionId }),
        ...(record.timeoutMs === undefined ? {} : { timeoutMs: Number(record.timeoutMs) }),
    }
}

function invalidConfig(index: number): Error {
    return new Error(`${SESSION_EXTENSIONS_ENV}[${index}] is invalid`)
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}
