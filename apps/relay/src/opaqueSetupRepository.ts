import { createOpaqueServerSetup } from '@codever/secure-channel'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Persists only the Relay's OPAQUE server setup; paired devices authenticate with NKey afterwards. */
export class OpaqueSetupRepository {
    private constructor(readonly serverSetup: string) {}

    static async open(path: string): Promise<OpaqueSetupRepository> {
        try {
            const value = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown; serverSetup?: unknown }
            if (value.version !== 1 || typeof value.serverSetup !== 'string' || !value.serverSetup) {
                throw new Error('Invalid OPAQUE setup repository')
            }
            await chmod(path, 0o600)
            return new OpaqueSetupRepository(value.serverSetup)
        } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
            const repository = new OpaqueSetupRepository(await createOpaqueServerSetup())
            await mkdir(dirname(path), { recursive: true, mode: 0o700 })
            const temporary = `${path}.${process.pid}.tmp`
            await writeFile(temporary, `${JSON.stringify({ version: 1, serverSetup: repository.serverSetup })}\n`, { mode: 0o600 })
            await rename(temporary, path)
            await chmod(path, 0o600)
            return repository
        }
    }
}
