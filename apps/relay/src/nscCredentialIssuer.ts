import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
    CODEVER_STREAMS,
    DURABLE_SYNC_PREFIX,
    clientConsumerName,
    clientEventsSubject,
    clientPairingResponsesSubject,
    clientResponsesSubject,
    gatewayCommandsSubject,
    gatewayConsumerName,
    gatewayPairingRequestsSubject,
    gatewayObjectBucketName,
    gatewayObjectStreamName,
    gatewayPresenceSubject,
} from '@codever/protocol'
import {
    AckPolicy, DeliverPolicy, DiscardPolicy, ReplayPolicy, RetentionPolicy, StorageType,
    type JetStreamManager, type StreamConfig,
} from '@nats-io/jetstream'
import { nanos } from '@nats-io/transport-node'

const executeFile = promisify(execFile)

export interface IssuedNatsCredential {
    publicKey: string
    userJwt: string
    websocketUrl: string
}

export interface NatsCredentialIssuer {
    issueClient(clientId: string, publicKey: string): Promise<IssuedNatsCredential>
    issueGateway(gatewayId: string, publicKey: string): Promise<{ publicKey: string; userJwt: string; natsUrl: string }>
}

export interface NscCredentialIssuerOptions {
    storeDirectory: string
    keysDirectory: string
    configDirectory: string
    operator: string
    account: string
    websocketUrl: string
    natsUrl: string
    jetstreamManager: JetStreamManager
    executable?: string
    run?: (args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr?: string }>
}

/** Uses the supported nsc CLI; the Relay never receives or stores a user seed. */
export class NscCredentialIssuer implements NatsCredentialIssuer {
    private queue = Promise.resolve()

    constructor(private readonly options: NscCredentialIssuerOptions) {
        const url = new URL(options.websocketUrl)
        if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('NATS WebSocket URL must use ws:// or wss://')
        const natsUrl = new URL(options.natsUrl)
        if (natsUrl.protocol !== 'nats:' && natsUrl.protocol !== 'tls:') throw new Error('Gateway NATS URL must use nats:// or tls://')
    }

    issueClient(clientId: string, publicKey: string): Promise<IssuedNatsCredential> {
        if (!/^[A-Za-z0-9_-]+$/.test(clientId)) return Promise.reject(new Error('Client ID is not safe for NATS credentials'))
        if (!/^U[A-Z2-7]{55}$/.test(publicKey)) return Promise.reject(new Error('Client NKey public key is invalid'))
        const operation = this.queue.then(() => this.issue(clientId, publicKey))
        this.queue = operation.then(() => undefined, () => undefined)
        return operation
    }

    issueGateway(gatewayId: string, publicKey: string): Promise<{ publicKey: string; userJwt: string; natsUrl: string }> {
        if (!/^[A-Za-z0-9_-]+$/.test(gatewayId)) return Promise.reject(new Error('Gateway ID is not safe for NATS credentials'))
        if (!/^U[A-Z2-7]{55}$/.test(publicKey)) return Promise.reject(new Error('Gateway NKey public key is invalid'))
        const operation = this.queue.then(() => this.issueGatewayCredential(gatewayId, publicKey))
        this.queue = operation.then(() => undefined, () => undefined)
        return operation
    }

    private async issue(clientId: string, publicKey: string): Promise<IssuedNatsCredential> {
        const name = `client-${createHash('sha256').update(`${clientId}:${publicKey}`).digest('hex').slice(0, 24)}`
        const env = {
            ...process.env,
            NSC_HOME: this.options.storeDirectory,
            NKEYS_PATH: this.options.keysDirectory,
        }
        await this.run(['env', '--store', this.options.storeDirectory], env)
        await this.run(['env', '--operator', this.options.operator], env)
        const permissions = clientPermissions(clientId)
        await this.run([
            'add', 'user', '--account', this.options.account, '--name', name, '-k', publicKey,
            ...permissions.publish.flatMap(subject => ['--allow-pub', subject]),
            ...permissions.subscribe.flatMap(subject => ['--allow-sub', subject]),
        ], env)
        const described = await this.run([
            'describe', 'user', '--account', this.options.account, '--name', name, '--raw',
        ], env)
        const userJwt = described.stdout.trim()
        if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(userJwt)) {
            throw new Error(`nsc did not return a valid user JWT${described.stderr ? `: ${described.stderr.trim()}` : ''}`)
        }
        await ensureClientConsumers(this.options.jetstreamManager, clientId)
        return { publicKey, userJwt, websocketUrl: this.options.websocketUrl }
    }

    private async issueGatewayCredential(
        gatewayId: string,
        publicKey: string,
    ): Promise<{ publicKey: string; userJwt: string; natsUrl: string }> {
        const name = `gateway-${createHash('sha256').update(`${gatewayId}:${publicKey}`).digest('hex').slice(0, 24)}`
        const env = { ...process.env, NSC_HOME: this.options.storeDirectory, NKEYS_PATH: this.options.keysDirectory }
        await this.run(['env', '--store', this.options.storeDirectory], env)
        await this.run(['env', '--operator', this.options.operator], env)
        const permissions = gatewayPermissions(gatewayId)
        await ensureGatewayObjectStore(this.options.jetstreamManager, gatewayId)
        await this.run([
            'add', 'user', '--account', this.options.account, '--name', name, '-k', publicKey,
            ...permissions.publish.flatMap(subject => ['--allow-pub', subject]),
            ...permissions.subscribe.flatMap(subject => ['--allow-sub', subject]),
        ], env)
        const described = await this.run([
            'describe', 'user', '--account', this.options.account, '--name', name, '--raw',
        ], env)
        const userJwt = described.stdout.trim()
        if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(userJwt)) {
            throw new Error(`nsc did not return a valid Gateway user JWT${described.stderr ? `: ${described.stderr.trim()}` : ''}`)
        }
        await ensureGatewayConsumer(this.options.jetstreamManager, gatewayId)
        return { publicKey, userJwt, natsUrl: this.options.natsUrl }
    }

    private run(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr?: string }> {
        const scopedArgs = [
            ...args,
            '--config-dir', this.options.configDirectory,
            '--data-dir', this.options.storeDirectory,
            '--keystore-dir', this.options.keysDirectory,
        ]
        if (this.options.run) return this.options.run(scopedArgs, env)
        return executeFile(this.options.executable ?? 'nsc', scopedArgs, {
            env,
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
        })
    }
}

export function clientPermissions(clientId: string): { publish: string[]; subscribe: string[] } {
    const responses = clientConsumerName(clientId, 'responses')
    const events = clientConsumerName(clientId, 'events')
    const inventory = clientConsumerName(clientId, 'inventory')
    const presence = clientConsumerName(clientId, 'presence')
    return {
        publish: [
            'cv.v1.gateway.*.commands',
            'cv.v1.gateway.*.pairing.requests',
            `$JS.API.CONSUMER.INFO.${CODEVER_STREAMS.responses}.${responses}`,
            `$JS.API.CONSUMER.MSG.NEXT.${CODEVER_STREAMS.responses}.${responses}`,
            `$JS.ACK.${CODEVER_STREAMS.responses}.${responses}.>`,
            `$JS.API.CONSUMER.INFO.${CODEVER_STREAMS.events}.${events}`,
            `$JS.API.CONSUMER.MSG.NEXT.${CODEVER_STREAMS.events}.${events}`,
            `$JS.ACK.${CODEVER_STREAMS.events}.${events}.>`,
            `$JS.API.CONSUMER.INFO.${CODEVER_STREAMS.inventory}.${inventory}`,
            `$JS.API.CONSUMER.MSG.NEXT.${CODEVER_STREAMS.inventory}.${inventory}`,
            `$JS.ACK.${CODEVER_STREAMS.inventory}.${inventory}.>`,
            `$JS.API.CONSUMER.INFO.${CODEVER_STREAMS.presence}.${presence}`,
            `$JS.API.CONSUMER.MSG.NEXT.${CODEVER_STREAMS.presence}.${presence}`,
            `$JS.ACK.${CODEVER_STREAMS.presence}.${presence}.>`,
        ],
        subscribe: [
            '_INBOX.>',
            clientResponsesSubject(clientId),
            clientEventsSubject(clientId),
            clientPairingResponsesSubject(clientId),
        ],
    }
}

export function gatewayPermissions(gatewayId: string): { publish: string[]; subscribe: string[] } {
    const consumer = gatewayConsumerName(gatewayId)
    const bucket = gatewayObjectBucketName(gatewayId)
    const objectStream = gatewayObjectStreamName(gatewayId)
    return {
        publish: [
            'cv.v1.client.*.responses',
            'cv.v1.client.*.events',
            'cv.v1.client.*.inventory.*',
            'cv.v1.client.*.pairing.responses',
            gatewayPresenceSubject(gatewayId),
            `$JS.API.CONSUMER.INFO.${CODEVER_STREAMS.commands}.${consumer}`,
            `$JS.API.CONSUMER.MSG.NEXT.${CODEVER_STREAMS.commands}.${consumer}`,
            `$JS.ACK.${CODEVER_STREAMS.commands}.${consumer}.>`,
            '$JS.API.INFO',
            `$O.${bucket}.>`,
            `$JS.API.STREAM.INFO.${objectStream}`,
            `$JS.API.STREAM.MSG.GET.${objectStream}`,
            `$JS.API.STREAM.PURGE.${objectStream}`,
            `$JS.API.CONSUMER.CREATE.${objectStream}.>`,
            `$JS.API.CONSUMER.DELETE.${objectStream}.>`,
            `$JS.API.CONSUMER.INFO.${objectStream}.>`,
        ],
        subscribe: ['_INBOX.>', gatewayCommandsSubject(gatewayId), gatewayPairingRequestsSubject(gatewayId)],
    }
}

export async function ensureGatewayObjectStore(manager: JetStreamManager, gatewayId: string): Promise<void> {
    const bucket = gatewayObjectBucketName(gatewayId)
    const name = gatewayObjectStreamName(gatewayId)
    const config = {
        name,
        description: `End-to-end encrypted Codever files for ${gatewayId}`,
        subjects: [`$O.${bucket}.C.>`, `$O.${bucket}.M.>`],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        discard: DiscardPolicy.New,
        max_age: 0,
        max_bytes: -1,
        max_msgs: -1,
        max_msgs_per_subject: -1,
        max_msg_size: -1,
        num_replicas: 1,
        allow_direct: true,
        allow_rollup_hdrs: true,
    } as StreamConfig
    try {
        await manager.streams.info(name)
        await manager.streams.update(name, config)
    } catch (error) {
        if (!(error instanceof Error) || !/stream not found/i.test(error.message)) throw error
        await manager.streams.add(config)
    }
}

export async function ensureGatewayConsumer(manager: JetStreamManager, gatewayId: string): Promise<void> {
    const name = gatewayConsumerName(gatewayId)
    const config = {
        durable_name: name,
        description: `Codever commands for ${gatewayId}`,
        filter_subject: gatewayCommandsSubject(gatewayId),
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        replay_policy: ReplayPolicy.Instant,
        ack_wait: nanos(30_000),
        max_ack_pending: 1,
        max_deliver: -1,
    } as const
    let exists = false
    for await (const info of manager.consumers.list(CODEVER_STREAMS.commands)) {
        if (info.name === name) { exists = true; break }
    }
    if (exists) await manager.consumers.update(CODEVER_STREAMS.commands, name, config)
    else await manager.consumers.add(CODEVER_STREAMS.commands, config)
}

export async function ensureClientConsumers(manager: JetStreamManager, clientId: string): Promise<void> {
    const specs = [
        {
            stream: CODEVER_STREAMS.responses,
            name: clientConsumerName(clientId, 'responses'),
            filter: clientResponsesSubject(clientId),
        },
        {
            stream: CODEVER_STREAMS.events,
            name: clientConsumerName(clientId, 'events'),
            filter: clientEventsSubject(clientId),
        },
        {
            stream: CODEVER_STREAMS.inventory,
            name: clientConsumerName(clientId, 'inventory'),
            filter: `${DURABLE_SYNC_PREFIX}.client.${clientId}.inventory.*`,
        },
        {
            stream: CODEVER_STREAMS.presence,
            name: clientConsumerName(clientId, 'presence'),
            filter: `${DURABLE_SYNC_PREFIX}.gateway.*.presence`,
        },
    ] as const
    for (const spec of specs) {
        const config = {
            durable_name: spec.name,
            description: `Codever ${spec.name}`,
            filter_subject: spec.filter,
            ack_policy: AckPolicy.Explicit,
            deliver_policy: DeliverPolicy.All,
            replay_policy: ReplayPolicy.Instant,
            ack_wait: nanos(30_000),
            max_ack_pending: 256,
            max_deliver: -1,
        } as const
        let exists = false
        for await (const info of manager.consumers.list(spec.stream)) {
            if (info.name === spec.name) { exists = true; break }
        }
        if (exists) await manager.consumers.update(spec.stream, spec.name, config)
        else await manager.consumers.add(spec.stream, config)
    }
}
