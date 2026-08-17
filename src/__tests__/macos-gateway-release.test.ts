import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { activateMacosGatewayRelease } from '@/ops/macosGatewayRelease'

describe('macOS Matrix Gateway release activation', () => {
    it('migrates a direct-release LaunchAgent to the stable current link', async () => {
        const root = await releaseFixture()
        try {
            const oldRelease = join(root, 'releases', 'old')
            const nextRelease = join(root, 'releases', 'next')
            const plistPath = join(root, 'gateway.plist')
            await writeFile(
                plistPath,
                `<string>${join(oldRelease, 'runtime', 'node')}</string>\n<string>${join(oldRelease, 'ops', 'matrix-local-gateway.js')}</string>`,
            )
            const restart = vi.fn(async () => undefined)

            await activateMacosGatewayRelease({
                releaseDirectory: nextRelease,
                installRoot: root,
                launchAgentPath: plistPath,
                serviceLabel: 'com.codever.test-gateway',
                adminSocketPath: join(root, 'admin.sock'),
            }, {
                restart,
                healthCheck: async () => undefined,
            })

            expect(await readlink(join(root, 'current'))).toBe(nextRelease)
            expect(await readFile(plistPath, 'utf8')).toContain(join(root, 'current'))
            expect(await readFile(plistPath, 'utf8')).not.toContain(oldRelease)
            expect(restart).toHaveBeenCalledWith(true)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('retries a transient bootstrap failure after unloading the old service', async () => {
        const root = await releaseFixture()
        try {
            const oldRelease = join(root, 'releases', 'old')
            const nextRelease = join(root, 'releases', 'next')
            const plistPath = join(root, 'gateway.plist')
            await writeFile(
                plistPath,
                `<string>${join(oldRelease, 'runtime', 'node')}</string>\n<string>${join(oldRelease, 'ops', 'matrix-local-gateway.js')}</string>`,
            )
            let bootstrapAttempts = 0
            const launchctl = vi.fn(async (arguments_: readonly string[]) => {
                if (arguments_[0] === 'bootstrap' && bootstrapAttempts++ === 0) {
                    throw new Error('Bootstrap failed: 5: Input/output error')
                }
            })
            const sleep = vi.fn(async () => undefined)

            await activateMacosGatewayRelease({
                releaseDirectory: nextRelease,
                installRoot: root,
                launchAgentPath: plistPath,
                serviceLabel: 'com.codever.test-gateway',
                adminSocketPath: join(root, 'admin.sock'),
            }, {
                launchctl,
                sleep,
                healthCheck: async () => undefined,
            })

            expect(bootstrapAttempts).toBe(2)
            expect(sleep).toHaveBeenCalledWith(250)
            expect(launchctl).toHaveBeenLastCalledWith([
                'kickstart',
                '-k',
                `gui/${process.getuid?.() ?? 0}/com.codever.test-gateway`,
            ])
            expect(await readlink(join(root, 'current'))).toBe(nextRelease)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('atomically switches the stable release and rolls back when health verification fails', async () => {
        const root = await releaseFixture()
        try {
            const oldRelease = join(root, 'releases', 'old')
            const nextRelease = join(root, 'releases', 'next')
            await symlink(oldRelease, join(root, 'current'))
            const plistPath = join(root, 'gateway.plist')
            await writeFile(plistPath, `<string>${join(root, 'current')}</string>`)
            const restart = vi.fn(async () => undefined)

            await expect(activateMacosGatewayRelease({
                releaseDirectory: nextRelease,
                installRoot: root,
                launchAgentPath: plistPath,
                serviceLabel: 'com.codever.test-gateway',
                adminSocketPath: join(root, 'admin.sock'),
                healthTimeoutMs: 20,
            }, {
                restart,
                healthCheck: async () => {
                    if (await readlink(join(root, 'current')) === nextRelease) {
                        throw new Error('new release is unhealthy')
                    }
                },
                sleep: async () => undefined,
            })).rejects.toThrow(/rolled back/i)

            expect(await readlink(join(root, 'current'))).toBe(oldRelease)
            expect(restart).toHaveBeenCalledTimes(2)
            expect(await readFile(plistPath, 'utf8')).toContain(join(root, 'current'))
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})

async function releaseFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'codever-macos-release-'))
    await Promise.all(['old', 'next'].map(async name => {
        const release = join(root, 'releases', name)
        await mkdir(join(release, 'runtime'), { recursive: true })
        await mkdir(join(release, 'ops'), { recursive: true })
        await writeFile(join(release, 'runtime', 'node'), '#!/bin/sh\n')
        await writeFile(join(release, 'ops', 'matrix-local-gateway.js'), '// gateway\n')
    }))
    return root
}
