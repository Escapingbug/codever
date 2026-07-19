import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import type { JWK } from '@codever/execution-auth'
import { JsonLineRpcPeer } from './gateway/matrix/jsonLineRpcPeer.js'
import {
    createGatewayApplication,
    defaultGatewayConfigPath,
    loadGatewayConfig,
    loadMatrixCredential,
    NativeMatrixTransport,
    type GatewayConfig,
    type NativeMatrixVerification,
    writeGatewayConfig,
    writeMatrixCredential,
} from './gateway/index.js'

async function main(): Promise<void> {
    const { positionals, values } = parseArgs({
        allowPositionals: true,
        options: {
            config: { type: 'string', short: 'c' },
            path: { type: 'string' },
            name: { type: 'string' },
            workspace: { type: 'string' },
            id: { type: 'string' },
            owner: { type: 'string' },
            key: { type: 'string' },
            homeserver: { type: 'string' },
            username: { type: 'string' },
            'password-file': { type: 'string' },
            'password-stdin': { type: 'boolean' },
            'matrix-transport': { type: 'string' },
            device: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
    })
    const command = positionals[0]
    const configPath = resolve(values.config ?? defaultGatewayConfigPath())
    if (values.help || !command) return help()

    if (command === 'init') {
        const required = ['homeserver', 'username', 'matrix-transport'] as const
        for (const key of required) if (!values[key]) throw new Error(`init requires --${key}`)
        if (Boolean(values['password-file']) === Boolean(values['password-stdin'])) {
            throw new Error('init requires exactly one of --password-file or --password-stdin')
        }
        const directory = dirname(configPath)
        const credentialPath = join(directory, 'matrix-credential.json')
        const storePassphrase = randomBytes(32).toString('base64url')
        const password = values['password-stdin']
            ? await readStandardInput()
            : await readFile(resolve(values['password-file']!), 'utf8')
        const login = await loginMatrixTransport({
            executablePath: resolve(values['matrix-transport']!),
            homeserver: values.homeserver!,
            username: values.username!,
            password: password.trim(),
            deviceDisplayName: values.name ?? process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'Codever Gateway',
            storePath: join(directory, 'matrix-store'),
            storePassphrase,
        })
        await writeMatrixCredential(credentialPath, {
            accessToken: login.session.accessToken,
            ...(login.session.refreshToken ? { refreshToken: login.session.refreshToken } : {}),
            storePassphrase,
        })
        const config = await writeGatewayConfig({
            name: values.name ?? process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'Codever Gateway',
            ...(values.workspace ? { workspaceId: values.workspace } : {}),
            matrix: {
                homeserver: values.homeserver!,
                userId: login.session.userId,
                deviceId: login.session.deviceId,
                controlRoomId: login.controlRoomId,
                credentialPath,
                storePath: join(directory, 'matrix-store'),
                transportBinaryPath: resolve(values['matrix-transport']!),
            },
        }, configPath)
        console.log(`Gateway config written: ${configPath}`)
        console.log(`Gateway ID: ${config.gatewayId}`)
        return
    }

    const config = await loadGatewayConfig(configPath)
    if (command === 'verify') {
        await verifyGatewayDevice(config, values.device)
        return
    }
    const application = await createGatewayApplication(config)
    if (command === 'project') {
        const subcommand = positionals[1]
        if (subcommand === 'add') {
            if (!values.path) throw new Error('project add requires --path')
            console.log(JSON.stringify(await application.projects.create({
                name: values.name ?? values.path,
                rootPath: values.path,
            }), null, 2))
        } else if (subcommand === 'list') {
            console.log(JSON.stringify(await application.projects.list({ includeArchived: true }), null, 2))
        } else throw new Error('project requires add or list')
        await application.close()
        return
    }
    if (command === 'control') {
        const subcommand = positionals[1]
        if (subcommand === 'trust') {
            if (!values.key || !values.owner) throw new Error('control trust requires --key and --owner')
            const publicKey = JSON.parse(await readFile(resolve(values.key), 'utf8')) as JWK
            console.log(JSON.stringify(await application.trustControlRoot(values.owner, publicKey, values.name), null, 2))
        } else if (subcommand === 'list') {
            console.log(JSON.stringify(await application.listControlRoots(), null, 2))
        } else if (subcommand === 'revoke') {
            if (!values.id) throw new Error('control revoke requires --id')
            console.log(JSON.stringify({ keyId: values.id, revoked: await application.revokeControlRoot(values.id) }, null, 2))
        } else throw new Error('control requires trust, list, or revoke')
        await application.close()
        return
    }
    if (command !== 'start') throw new Error(`Unknown command: ${command}`)

    try {
        await application.start()
    } catch (error) {
        await application.close()
        throw error
    }
    console.log(`Gateway ${config.name} (${config.gatewayId}) connected to ${config.matrix.homeserver}`)
    const shutdown = async () => {
        await application.close()
        process.exit(0)
    }
    process.once('SIGINT', () => void shutdown())
    process.once('SIGTERM', () => void shutdown())
}

function help(): void {
    console.log(`codever gateway

Usage:
  codever init --homeserver <https-url> --username <localpart-or-mxid>
               (--password-file <path> | --password-stdin)
               --matrix-transport <native-binary>
               [--name <machine-name>]
  codever project add --path <absolute-path> [--name <name>]
  codever project list [-c <config>]
  codever control trust --owner <owner-id> --key <public-jwk.json> [-c <config>]
  codever control list [-c <config>]
  codever control revoke --id <key-id> [-c <config>]
  codever verify [-c <config>] [--device <matrix-device-id>]
  codever start [-c <config>]
`)
}

async function verifyGatewayDevice(config: GatewayConfig, expectedDevice?: string): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('Device verification requires an interactive terminal')
    }
    const credential = await loadMatrixCredential(config)
    const transport = new NativeMatrixTransport({
        executablePath: config.matrix.transportBinaryPath,
        session: credential.session,
        storePath: config.matrix.storePath,
        storePassphrase: credential.storePassphrase,
        onSessionCredential: session => writeMatrixCredential(config.matrix.credentialPath, {
            accessToken: session.accessToken,
            ...(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
            storePassphrase: credential.storePassphrase,
        }),
        onError: error => console.error(`[matrix] ${error.message}`),
    })
    await transport.initialize()
    console.log(`Gateway Matrix device: ${config.matrix.deviceId}`)
    console.log('Waiting up to three minutes for a verification request from the client...')
    try {
        const flow = await waitForVerificationSas(transport, expectedDevice)
        console.log(`Verification request from ${flow.otherDeviceId ?? expectedDevice ?? 'another device'}:`)
        console.log((flow.emojis ?? []).map(value => `${value.symbol} ${value.description}`).join('   '))
        const prompt = createInterface({ input: process.stdin, output: process.stdout })
        let answer: string
        try {
            answer = await prompt.question('Do both devices show these emoji in this order? [y/N] ')
        } finally {
            prompt.close()
        }
        if (!/^y(?:es)?$/i.test(answer.trim())) {
            await transport.confirmVerification(flow.flowId, false)
            throw new Error('Device verification cancelled because the emoji did not match')
        }
        await transport.confirmVerification(flow.flowId, true)
        const done = await waitForVerificationDone(transport, flow.flowId)
        if (done.stage !== 'done') throw new Error(done.cancellation?.reason ?? 'Device verification did not complete')
        console.log(`Matrix device ${done.otherDeviceId ?? flow.otherDeviceId ?? ''} is verified.`)
    } finally {
        await transport.close()
    }
}

async function waitForVerificationSas(
    transport: NativeMatrixTransport,
    expectedDevice?: string,
): Promise<NativeMatrixVerification> {
    const deadline = Date.now() + 180_000
    let previousStage = ''
    while (Date.now() < deadline) {
        const requests = await transport.listVerifications()
        const flow = requests.find(value => !['done', 'cancelled'].includes(value.stage)
            && (!expectedDevice || !value.otherDeviceId || value.otherDeviceId === expectedDevice))
        if (!flow) {
            await delay(500)
            continue
        }
        const advanced = await transport.advanceVerification(flow.flowId)
        if (advanced.stage !== previousStage) {
            console.log(`Verification state: ${advanced.stage}`)
            previousStage = advanced.stage
        }
        if (advanced.stage === 'present_sas') return advanced
        if (advanced.stage === 'cancelled') throw new Error(advanced.cancellation?.reason ?? 'Device verification was cancelled')
        await delay(500)
    }
    throw new Error('No Matrix device verification reached emoji comparison within three minutes')
}

async function waitForVerificationDone(
    transport: NativeMatrixTransport,
    flowId: string,
): Promise<NativeMatrixVerification> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
        const flow = await transport.advanceVerification(flowId)
        if (flow.stage === 'done' || flow.stage === 'cancelled') return flow
        await delay(500)
    }
    throw new Error('Matrix device verification confirmation timed out')
}

interface MatrixLoginResult {
    session: {
        homeserver: string
        userId: string
        deviceId: string
        accessToken: string
        refreshToken?: string
    }
    controlRoomId: string
}

async function loginMatrixTransport(input: {
    executablePath: string
    homeserver: string
    username: string
    password: string
    deviceDisplayName: string
    storePath: string
    storePassphrase: string
}): Promise<MatrixLoginResult> {
    const child = spawn(input.executablePath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
    })
    const peer = new JsonLineRpcPeer(child.stdout, child.stdin, 120_000)
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', value => { stderr = `${stderr}${String(value)}`.slice(-8_192) })
    child.on('error', error => peer.close(error))
    child.on('exit', (code, signal) => peer.close(new Error(
        `Matrix transport exited during login (${code ?? signal ?? 'unknown'}): ${stderr.trim()}`,
    )))
    try {
        return await peer.request<MatrixLoginResult>('login', {
            homeserver: input.homeserver,
            username: input.username,
            password: input.password,
            deviceDisplayName: input.deviceDisplayName,
            storePath: input.storePath,
            storePassphrase: input.storePassphrase,
        })
    } finally {
        peer.close()
        child.kill()
    }
}

async function readStandardInput(): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks).toString('utf8')
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
})
