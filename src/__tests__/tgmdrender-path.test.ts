import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

describe('tgmdrender script path resolution', () => {
    const originalCwd = process.cwd()
    const originalEnv = process.env.CODEVER_TGMDRENDER_PY
    let tempDir: string | undefined

    beforeEach(() => {
        vi.resetModules()
        tempDir = mkdtempSync(join(tmpdir(), 'codever-tgmdrender-'))
    })

    afterEach(() => {
        vi.doUnmock('node:child_process')
        vi.doUnmock('node:fs')
        vi.resetModules()
        process.chdir(originalCwd)

        if (originalEnv === undefined) {
            delete process.env.CODEVER_TGMDRENDER_PY
        } else {
            process.env.CODEVER_TGMDRENDER_PY = originalEnv
        }

        if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    })

    it('does not resolve tgmdrender.py from an unrelated cwd', async () => {
        const repoScript = resolve(originalCwd, 'scripts/tgmdrender.py')
        const spawnSync = vi.fn(() => ({ status: 0, stdout: '[]', stderr: '' }))

        vi.doMock('node:fs', async () => {
            const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
            return {
                ...actual,
                existsSync: (path: string) => path === repoScript,
            }
        })
        vi.doMock('node:child_process', async () => {
            const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
            return {
                ...actual,
                spawnSync,
            }
        })

        process.chdir(tempDir!)
        const { checkTgmdrender } = await import('@/utils/tgmdrender')

        expect(checkTgmdrender()).toEqual({ available: true })
        expect(spawnSync).toHaveBeenCalledWith(
            'python',
            [repoScript, 'convert', '--no-split'],
            expect.any(Object),
        )
    })
})
