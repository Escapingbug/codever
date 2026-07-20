import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolOutputListItemDto, ToolOutputReference } from '@codever/protocol'

const DEFAULT_CHUNK_SIZE = 128 * 1024
const MAX_CHUNK_SIZE = 192 * 1024

export interface RetainToolOutputInput {
    sessionId: string
    toolCallId: string
    toolName: string
    value: unknown
    createdAt: string
}

/** Gateway-local storage for tool results. Bodies never enter the event journal or Matrix. */
export class GatewayToolOutputStore {
    private constructor(private readonly root: string) {}

    static async open(dataDirectory: string): Promise<GatewayToolOutputStore> {
        const root = join(dataDirectory, 'tool-outputs')
        await mkdir(root, { recursive: true })
        return new GatewayToolOutputStore(root)
    }

    async retain(input: RetainToolOutputInput): Promise<ToolOutputReference> {
        const outputId = `toolout_${randomUUID()}`
        const directory = this.sessionDirectory(input.sessionId)
        await mkdir(directory, { recursive: true })
        const body = Buffer.from(JSON.stringify(input.value), 'utf8')
        const descriptor: ToolOutputReference = {
            outputId,
            sizeBytes: body.byteLength,
            sha256: createHash('sha256').update(body).digest('hex'),
            mediaType: 'application/json',
        }
        const metadata: ToolOutputListItemDto = {
            ...descriptor,
            sessionId: input.sessionId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            createdAt: input.createdAt,
        }
        const bodyPath = join(directory, `${outputId}.json`)
        const metadataPath = join(directory, `${outputId}.meta.json`)
        await atomicWrite(bodyPath, body)
        try {
            await atomicWrite(metadataPath, Buffer.from(JSON.stringify(metadata), 'utf8'))
        } catch (error) {
            await rm(bodyPath, { force: true }).catch(() => undefined)
            throw error
        }
        return descriptor
    }

    async list(sessionId: string): Promise<ToolOutputListItemDto[]> {
        const directory = this.sessionDirectory(sessionId)
        const names = await readdir(directory).catch(error => isMissing(error) ? [] : Promise.reject(error))
        const records = await Promise.all(names
            .filter(name => name.endsWith('.meta.json'))
            .map(async name => JSON.parse(await readFile(join(directory, name), 'utf8')) as ToolOutputListItemDto))
        return records
            .filter(record => record.sessionId === sessionId)
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    }

    async readChunk(sessionId: string, outputId: string, offset: number, limit = DEFAULT_CHUNK_SIZE) {
        const metadata = (await this.list(sessionId)).find(item => item.outputId === outputId)
        if (!metadata) throw new Error('Tool output is unknown or has been deleted')
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > metadata.sizeBytes) {
            throw new Error('Tool output offset is invalid')
        }
        const boundedLimit = Math.min(Math.max(1, limit), MAX_CHUNK_SIZE)
        const length = Math.min(boundedLimit, metadata.sizeBytes - offset)
        const body = Buffer.alloc(length)
        const handle = await open(join(this.sessionDirectory(sessionId), `${outputId}.json`), 'r')
        try {
            const { bytesRead } = await handle.read(body, 0, length, offset)
            if (bytesRead !== length) throw new Error('Tool output changed while it was being read')
        } finally {
            await handle.close()
        }
        const end = offset + length
        return {
            outputId,
            offset,
            data: body.toString('base64'),
            nextOffset: end < metadata.sizeBytes ? end : null,
        }
    }

    async delete(sessionId: string, outputIds: string[]): Promise<number> {
        const known = new Set((await this.list(sessionId)).map(item => item.outputId))
        let deleted = 0
        for (const outputId of new Set(outputIds)) {
            if (!known.has(outputId)) continue
            const directory = this.sessionDirectory(sessionId)
            await Promise.all([
                rm(join(directory, `${outputId}.json`), { force: true }),
                rm(join(directory, `${outputId}.meta.json`), { force: true }),
            ])
            deleted += 1
        }
        return deleted
    }

    async clear(sessionId: string): Promise<number> {
        const count = (await this.list(sessionId)).length
        await rm(this.sessionDirectory(sessionId), { recursive: true, force: true })
        return count
    }

    private sessionDirectory(sessionId: string): string {
        return join(this.root, createHash('sha256').update(sessionId).digest('hex'))
    }
}

async function atomicWrite(path: string, contents: Buffer): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, contents)
    await rename(temporary, path)
}

function isMissing(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
