import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
    access,
    chmod,
    mkdir,
    readFile,
    readlink,
    rename,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { GatewayAdminClient } from '../gateway/admin/client.js'

export interface MacosGatewayReleaseOptions {
    releaseDirectory: string
    installRoot: string
    launchAgentPath: string
    serviceLabel: string
    adminSocketPath: string
    healthTimeoutMs?: number
}

export interface MacosGatewayReleaseDependencies {
    restart?: (reloadLaunchAgent: boolean) => Promise<void>
    healthCheck?: () => Promise<void>
    sleep?: (milliseconds: number) => Promise<void>
}

/**
 * Activates a prepared release through a stable symlink. Once the LaunchAgent
 * points at `current`, later deployments never unload it: launchd remains the
 * recovery owner while the release switch and rollback are atomic renames.
 */
export async function activateMacosGatewayRelease(
    input: MacosGatewayReleaseOptions,
    dependencies: MacosGatewayReleaseDependencies = {},
): Promise<void> {
    const releaseDirectory = resolve(input.releaseDirectory)
    const installRoot = resolve(input.installRoot)
    const currentLink = join(installRoot, 'current')
    const launchAgentPath = resolve(input.launchAgentPath)
    await validateRelease(releaseDirectory)
    await mkdir(installRoot, { recursive: true })

    const previousTarget = await readLinkIfPresent(currentLink)
    const originalPlist = await readFile(launchAgentPath, 'utf8')
    const stablePlist = stableLaunchAgentPlist(
        originalPlist,
        currentLink,
        dirname(releaseDirectory),
        [previousTarget, releaseDirectory].filter((value): value is string => Boolean(value)),
    )
    const reloadLaunchAgent = stablePlist !== originalPlist
    const restart = dependencies.restart ?? (reload =>
        restartLaunchAgent(input.serviceLabel, launchAgentPath, reload))
    const healthCheck = dependencies.healthCheck ?? (() =>
        new GatewayAdminClient({
            socketPath: input.adminSocketPath,
            timeoutMs: 2_000,
        }).status().then(status => {
            if (status.state !== 'running') {
                throw new Error(`Gateway reported ${status.state}`)
            }
        }))
    const sleep = dependencies.sleep ?? (milliseconds =>
        new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds)))

    if (reloadLaunchAgent) await atomicWrite(launchAgentPath, stablePlist)
    await replaceSymlink(currentLink, releaseDirectory)
    try {
        await restart(reloadLaunchAgent)
        await waitForHealth(healthCheck, sleep, input.healthTimeoutMs ?? 30_000)
    } catch (activationError) {
        try {
            if (previousTarget) await replaceSymlink(currentLink, previousTarget)
            else await rm(currentLink, { force: true })
            if (reloadLaunchAgent) await atomicWrite(launchAgentPath, originalPlist)
            await restart(reloadLaunchAgent)
            await waitForHealth(healthCheck, sleep, input.healthTimeoutMs ?? 30_000)
        } catch (rollbackError) {
            throw new Error(
                `Matrix Gateway activation failed and rollback also failed: ${formatError(rollbackError)}`,
                { cause: activationError },
            )
        }
        throw new Error(
            `Matrix Gateway activation failed and was rolled back: ${formatError(activationError)}`,
            { cause: activationError },
        )
    }
}

async function validateRelease(releaseDirectory: string): Promise<void> {
    await access(join(releaseDirectory, 'runtime', 'node'), constants.X_OK)
        .catch(async () => {
            await access(join(releaseDirectory, 'runtime', 'node'), constants.F_OK)
            await chmod(join(releaseDirectory, 'runtime', 'node'), 0o755)
        })
    await access(join(releaseDirectory, 'ops', 'matrix-local-gateway.js'), constants.R_OK)
}

function stableLaunchAgentPlist(
    plist: string,
    currentLink: string,
    releasesRoot: string,
    releaseDirectories: readonly string[],
): string {
    if (plist.includes(currentLink)) return plist
    for (const releaseDirectory of releaseDirectories) {
        if (!plist.includes(releaseDirectory)) continue
        return plist.replaceAll(releaseDirectory, currentLink)
    }
    const releasePath = new RegExp(
        `${escapeRegExp(releasesRoot)}/[^/\\s<]+`,
        'gu',
    )
    const migrated = plist.replace(releasePath, currentLink)
    if (migrated !== plist) return migrated
    throw new Error(
        'LaunchAgent does not reference either the stable current link or the release being activated.',
    )
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

async function replaceSymlink(path: string, target: string): Promise<void> {
    const temporary = `${path}.next.${process.pid}.${randomUUID()}`
    await symlink(target, temporary)
    try {
        await rename(temporary, path)
    } finally {
        await rm(temporary, { force: true })
    }
}

async function atomicWrite(path: string, content: string): Promise<void> {
    const temporary = `${path}.next.${process.pid}.${randomUUID()}`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, content, { mode: 0o644 })
    await rename(temporary, path)
}

async function readLinkIfPresent(path: string): Promise<string | null> {
    try {
        return await readlink(path)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    }
}

async function restartLaunchAgent(
    label: string,
    plistPath: string,
    reload: boolean,
): Promise<void> {
    const userDomain = `gui/${process.getuid?.() ?? 0}`
    const service = `${userDomain}/${label}`
    if (reload) {
        await runLaunchctl(['bootout', service]).catch(() => undefined)
        await runLaunchctl(['bootstrap', userDomain, plistPath])
    }
    try {
        await runLaunchctl(['kickstart', '-k', service])
    } catch (error) {
        if (reload) throw error
        await runLaunchctl(['bootstrap', userDomain, plistPath])
        await runLaunchctl(['kickstart', '-k', service])
    }
}

function runLaunchctl(arguments_: readonly string[]): Promise<void> {
    return new Promise((resolveRun, reject) => {
        const child = spawn('/bin/launchctl', arguments_, { stdio: 'inherit' })
        child.once('error', reject)
        child.once('exit', code => {
            if (code === 0) resolveRun()
            else reject(new Error(`launchctl ${arguments_.join(' ')} exited with ${code}`))
        })
    })
}

async function waitForHealth(
    healthCheck: () => Promise<void>,
    sleep: (milliseconds: number) => Promise<void>,
    timeoutMs: number,
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown = new Error('Gateway health check did not run')
    do {
        try {
            await healthCheck()
            return
        } catch (error) {
            lastError = error
        }
        await sleep(Math.min(250, Math.max(0, deadline - Date.now())))
    } while (Date.now() < deadline)
    throw new Error(`Gateway did not become healthy: ${formatError(lastError)}`)
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
