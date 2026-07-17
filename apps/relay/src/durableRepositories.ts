import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseGateway, type Gateway } from '@codever/protocol'
import type { GatewayRepository } from './repositories'
import type { RelayRepositories } from './server'

const FORMAT_VERSION = 1
const clone = <T>(value: T): T => structuredClone(value)

interface GatewaySnapshot {
    formatVersion: 1
    gateways: Gateway[]
}

class SerialExecutor {
    private tail: Promise<void> = Promise.resolve()

    run(operation: () => Promise<void>): Promise<void> {
        const result = this.tail.then(operation, operation)
        this.tail = result.then(() => undefined, () => undefined)
        return result
    }
}

export class DurableGatewayRepository implements GatewayRepository {
    private readonly serial = new SerialExecutor()

    private constructor(private readonly path: string, private snapshot: GatewaySnapshot) {}

    static async open(path: string): Promise<DurableGatewayRepository> {
        let value: unknown
        try {
            value = JSON.parse(await readFile(path, 'utf8'))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw new Error(`Unable to load Relay gateways at ${path}`, { cause: error })
            }
        }
        const repository = new DurableGatewayRepository(path, value === undefined ? emptySnapshot() : parseSnapshot(value, path))
        await repository.markDisconnected()
        return repository
    }

    async list(): Promise<Gateway[]> {
        return this.snapshot.gateways.map(clone)
    }

    async get(id: string): Promise<Gateway | undefined> {
        const value = this.snapshot.gateways.find(gateway => gateway.id === id)
        return value && clone(value)
    }

    async upsert(gateway: Gateway): Promise<void> {
        const parsed = parseGateway(gateway)
        await this.mutate(next => {
            const index = next.gateways.findIndex(value => value.id === parsed.id)
            if (index < 0) next.gateways.push(clone(parsed))
            else next.gateways[index] = clone(parsed)
        })
    }

    async updateConnection(id: string, status: Gateway['status'], connectionEpoch?: string, lastSeenAt?: string): Promise<void> {
        await this.mutate(next => {
            const gateway = next.gateways.find(value => value.id === id)
            if (!gateway) return
            gateway.status = status
            gateway.lastSeenAt = lastSeenAt ?? gateway.lastSeenAt
            if (connectionEpoch === undefined) delete gateway.connectionEpoch
            else gateway.connectionEpoch = connectionEpoch
        })
    }

    private async markDisconnected(): Promise<void> {
        if (!this.snapshot.gateways.some(gateway => gateway.status === 'online' || gateway.connectionEpoch)) return
        await this.mutate(next => {
            for (const gateway of next.gateways) {
                gateway.status = 'offline'
                delete gateway.connectionEpoch
            }
        })
    }

    private mutate(operation: (snapshot: GatewaySnapshot) => void): Promise<void> {
        return this.serial.run(async () => {
            const next = clone(this.snapshot)
            operation(next)
            const parsed = parseSnapshot(next, this.path)
            await atomicWriteJson(this.path, parsed)
            this.snapshot = parsed
        })
    }
}

export async function createDurableRelayRepositories(directory: string): Promise<RelayRepositories> {
    return { gateways: await DurableGatewayRepository.open(join(directory, 'gateways.json')) }
}

function emptySnapshot(): GatewaySnapshot {
    return { formatVersion: FORMAT_VERSION, gateways: [] }
}

function parseSnapshot(value: unknown, label: string): GatewaySnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid Relay gateway store at ${label}`)
    const object = value as Record<string, unknown>
    if (Object.keys(object).some(key => key !== 'formatVersion' && key !== 'gateways')) {
        throw new Error(`Invalid Relay gateway store at ${label}`)
    }
    if (object.formatVersion !== FORMAT_VERSION || !Array.isArray(object.gateways)) {
        throw new Error(`Invalid Relay gateway store at ${label}`)
    }
    const gateways = object.gateways.map(parseGateway)
    if (new Set(gateways.map(gateway => gateway.id)).size !== gateways.length) {
        throw new Error(`Duplicate Gateway id in Relay gateway store at ${label}`)
    }
    return { formatVersion: FORMAT_VERSION, gateways }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
    }
}
