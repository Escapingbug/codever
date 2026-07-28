import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface MatrixPinnedDeviceStore {
    isPinned(roomId: string, sender: string, deviceId: string): Promise<boolean>
}

/**
 * `claim` must be atomic for concurrent calls. It returns true only for the
 * first observation of a fingerprint.
 */
export interface MatrixReplayFingerprintStore {
    claim(fingerprint: string): Promise<boolean>
}

export class InMemoryMatrixPinnedDeviceStore implements MatrixPinnedDeviceStore {
    private readonly entries = new Set<string>()

    pin(roomId: string, sender: string, deviceId: string): void {
        this.entries.add(deviceKey(roomId, sender, deviceId))
    }

    unpin(roomId: string, sender: string, deviceId: string): void {
        this.entries.delete(deviceKey(roomId, sender, deviceId))
    }

    async isPinned(roomId: string, sender: string, deviceId: string): Promise<boolean> {
        return this.entries.has(deviceKey(roomId, sender, deviceId))
    }
}

export class InMemoryMatrixReplayFingerprintStore implements MatrixReplayFingerprintStore {
    private readonly fingerprints = new Set<string>()

    async claim(fingerprint: string): Promise<boolean> {
        if (this.fingerprints.has(fingerprint)) return false
        this.fingerprints.add(fingerprint)
        return true
    }
}

/**
 * Append-only replay ledger. Each successful claim is flushed before it is
 * reported as accepted, so a process restart cannot re-execute an event that
 * was already admitted by the router.
 */
export class FileMatrixReplayFingerprintStore implements MatrixReplayFingerprintStore {
    private loaded = false
    private readonly fingerprints = new Set<string>()
    private chain: Promise<unknown> = Promise.resolve()

    constructor(private readonly filePath: string) {}

    claim(fingerprint: string): Promise<boolean> {
        const operation = this.chain.then(async () => {
            await this.load()
            if (this.fingerprints.has(fingerprint)) return false

            await mkdir(dirname(this.filePath), { recursive: true })
            await appendFile(this.filePath, `${JSON.stringify(fingerprint)}\n`, 'utf8')
            this.fingerprints.add(fingerprint)
            return true
        })
        this.chain = operation.then(() => undefined, () => undefined)
        return operation
    }

    private async load(): Promise<void> {
        if (this.loaded) return
        this.loaded = true

        let text: string
        try {
            text = await readFile(this.filePath, 'utf8')
        } catch (error) {
            if (isMissingFile(error)) return
            throw error
        }

        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue
            const value: unknown = JSON.parse(line)
            if (typeof value !== 'string') {
                throw new Error(`Invalid Matrix replay ledger entry in ${this.filePath}`)
            }
            this.fingerprints.add(value)
        }
    }
}

function deviceKey(roomId: string, sender: string, deviceId: string): string {
    return JSON.stringify([roomId, sender, deviceId])
}

function isMissingFile(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
