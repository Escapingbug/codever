import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface GatewaySecureCredential {
    version: 1
    gatewayId: string
    relayId: string
    relayStaticPublicKey: string
    secret: string
    createdAt: string
}

export class GatewaySecureCredentialStore {
    constructor(readonly path: string) {}

    async load(gatewayId: string): Promise<GatewaySecureCredential | undefined> {
        let value: unknown
        try {
            value = JSON.parse(await readFile(this.path, 'utf8'))
            await chmod(this.path, 0o600)
        } catch (error) {
            if (isNotFound(error)) return undefined
            throw new Error(`Unable to read secure Relay credential at ${this.path}`, { cause: error })
        }
        const credential = parseCredential(value)
        if (credential.gatewayId !== gatewayId) throw new Error('Secure Relay credential belongs to another Gateway')
        return credential
    }

    async save(credential: GatewaySecureCredential): Promise<void> {
        const value = parseCredential(credential)
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        const temporary = `${this.path}.${process.pid}.tmp`
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
        await rename(temporary, this.path)
        await chmod(this.path, 0o600)
    }
}

function parseCredential(value: unknown): GatewaySecureCredential {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid secure Relay credential')
    const input = value as Record<string, unknown>
    if (input.version !== 1) throw new Error('Unsupported secure Relay credential version')
    for (const field of ['gatewayId', 'relayId', 'relayStaticPublicKey', 'secret', 'createdAt'] as const) {
        if (typeof input[field] !== 'string' || input[field].length === 0) throw new Error(`Invalid secure Relay credential ${field}`)
    }
    if ((input.secret as string).length < 32) throw new Error('Secure Relay credential secret is too short')
    return {
        version: 1,
        gatewayId: input.gatewayId as string,
        relayId: input.relayId as string,
        relayStaticPublicKey: input.relayStaticPublicKey as string,
        secret: input.secret as string,
        createdAt: input.createdAt as string,
    }
}

function isNotFound(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
