import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const relayDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('Relay executable entry point', () => {
    it('starts with deny-all client authentication by default', async () => {
        const relay = await startRelay({})
        try {
            const response = await fetch(`${relay.address}/v1/gateways`)
            expect(response.status).toBe(401)
            expect(relay.stderr()).not.toContain('INSECURE_DEV_AUTH=true')
        } finally {
            await relay.stop()
        }
    })

    it('allows clients only when insecure development authentication is explicitly true', async () => {
        const relay = await startRelay({ CODEVER_RELAY_INSECURE_DEV_AUTH: 'true' })
        try {
            const response = await fetch(`${relay.address}/v1/gateways`)
            expect(response.status).toBe(200)
            expect(relay.stderr()).toContain('CODEVER_RELAY_INSECURE_DEV_AUTH=true')
        } finally {
            await relay.stop()
        }
    })
})

async function startRelay(overrides: NodeJS.ProcessEnv): Promise<{
    address: string
    stderr: () => string
    stop: () => Promise<void>
}> {
    const port = await availablePort()
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
        cwd: relayDirectory,
        env: {
            ...process.env,
            CODEVER_RELAY_HOST: '127.0.0.1',
            CODEVER_RELAY_PORT: String(port),
            CODEVER_RELAY_LOGGER: 'false',
            CODEVER_RELAY_CONFIG: undefined,
            CODEVER_RELAY_ENROLLMENT_FILE: undefined,
            CODEVER_RELAY_GATEWAYS_JSON: undefined,
            CODEVER_RELAY_INSECURE_DEV_AUTH: undefined,
            CODEVER_RELAY_REPOSITORY_MODE: 'memory',
            ...overrides,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    const address = `http://127.0.0.1:${port}`
    try {
        await waitUntilHealthy(child, address)
    } catch (error) {
        child.kill()
        throw new Error(`Relay entry point failed to start: ${stderr}`, { cause: error })
    }
    return {
        address,
        stderr: () => stderr,
        stop: () => stopChild(child),
    }
}

async function waitUntilHealthy(child: ChildProcess, address: string): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Relay exited with code ${child.exitCode}`)
        try {
            const response = await fetch(`${address}/health`)
            if (response.ok) return
        } catch {
            // Startup has not bound the socket yet.
        }
        await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('Relay did not become healthy before timeout')
}

async function stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    await Promise.race([
        exited,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Relay did not stop after SIGTERM')), 5_000)),
    ])
}

async function availablePort(): Promise<number> {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Unable to allocate a Relay test port')
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    return address.port
}
