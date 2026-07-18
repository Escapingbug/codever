import {
    CODEVER_STREAMS,
    DURABLE_SYNC_PREFIX,
} from '@codever/protocol'
import {
    DiscardPolicy,
    RetentionPolicy,
    StorageType,
    jetstreamManager,
    type JetStreamManager,
    type StreamConfig,
} from '@nats-io/jetstream'
import { connect, credsAuthenticator, nanos, type NatsConnection } from '@nats-io/transport-node'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

export type CodeverStreamSpec = Readonly<Pick<StreamConfig,
    'name' | 'subjects' | 'description' | 'retention' | 'storage' | 'discard'
    | 'max_age' | 'max_bytes' | 'max_msgs_per_subject' | 'duplicate_window'
    | 'allow_direct' | 'allow_rollup_hdrs' | 'num_replicas'>>

export const CODEVER_STREAM_TOPOLOGY: readonly CodeverStreamSpec[] = [
    {
        name: CODEVER_STREAMS.commands,
        subjects: [`${DURABLE_SYNC_PREFIX}.gateway.*.commands`],
        description: 'Durable, encrypted commands waiting for a Codever Gateway',
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        discard: DiscardPolicy.Old,
        max_age: nanos(7 * DAY),
        max_bytes: -1,
        max_msgs_per_subject: -1,
        duplicate_window: nanos(10 * MINUTE),
        allow_direct: false,
        allow_rollup_hdrs: false,
        num_replicas: 1,
    },
    {
        name: CODEVER_STREAMS.responses,
        subjects: [`${DURABLE_SYNC_PREFIX}.client.*.responses`],
        description: 'Encrypted command outcomes, replayable independently of a connection',
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        discard: DiscardPolicy.Old,
        max_age: nanos(30 * DAY),
        max_bytes: -1,
        max_msgs_per_subject: 10_000,
        duplicate_window: nanos(10 * MINUTE),
        allow_direct: true,
        allow_rollup_hdrs: false,
        num_replicas: 1,
    },
    {
        name: CODEVER_STREAMS.events,
        subjects: [`${DURABLE_SYNC_PREFIX}.client.*.events`],
        description: 'Encrypted AG-UI conversation events and A2A task transitions',
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        discard: DiscardPolicy.Old,
        max_age: nanos(180 * DAY),
        max_bytes: -1,
        max_msgs_per_subject: -1,
        duplicate_window: nanos(10 * MINUTE),
        allow_direct: true,
        allow_rollup_hdrs: false,
        num_replicas: 1,
    },
    {
        name: CODEVER_STREAMS.inventory,
        subjects: [`${DURABLE_SYNC_PREFIX}.client.*.inventory.*`],
        description: 'Latest encrypted Gateway inventory per paired client',
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        discard: DiscardPolicy.Old,
        max_age: nanos(30 * DAY),
        max_bytes: -1,
        max_msgs_per_subject: 1,
        duplicate_window: nanos(10 * MINUTE),
        allow_direct: true,
        allow_rollup_hdrs: true,
        num_replicas: 1,
    },
    {
        name: CODEVER_STREAMS.pairing,
        subjects: [
            `${DURABLE_SYNC_PREFIX}.gateway.*.pairing.requests`,
            `${DURABLE_SYNC_PREFIX}.client.*.pairing.responses`,
        ],
        description: 'Short-lived OPAQUE Gateway pairing exchanges',
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        discard: DiscardPolicy.Old,
        max_age: nanos(3 * MINUTE),
        max_bytes: 16 * 1024 * 1024,
        max_msgs_per_subject: 128,
        duplicate_window: nanos(3 * MINUTE),
        allow_direct: false,
        allow_rollup_hdrs: false,
        num_replicas: 1,
    },
    {
        name: CODEVER_STREAMS.presence,
        subjects: [`${DURABLE_SYNC_PREFIX}.gateway.*.presence`],
        description: 'Authenticated latest Gateway discovery records',
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        discard: DiscardPolicy.Old,
        max_age: nanos(2 * MINUTE),
        max_bytes: 16 * 1024 * 1024,
        max_msgs_per_subject: 1,
        duplicate_window: nanos(30_000),
        allow_direct: true,
        allow_rollup_hdrs: true,
        num_replicas: 1,
    },
] as const

export interface CodeverJetStreamRuntime {
    connection: NatsConnection
    manager: JetStreamManager
    close(): Promise<void>
}

export async function startCodeverJetStream(url: string, credentials?: Uint8Array): Promise<CodeverJetStreamRuntime> {
    const connection = await connect({
        servers: [url],
        name: 'codever-relay-control',
        authenticator: credentials ? credsAuthenticator(credentials) : undefined,
    })
    try {
        const manager = await jetstreamManager(connection)
        await ensureCodeverStreams(manager)
        let stopping = false
        const topologyMonitor = monitorTopology(connection, manager, () => stopping)
        return {
            connection,
            manager,
            close: async () => {
                stopping = true
                await connection.drain()
                await topologyMonitor
            },
        }
    } catch (error) {
        await connection.close()
        throw error
    }
}

async function monitorTopology(
    connection: NatsConnection,
    manager: JetStreamManager,
    stopping: () => boolean,
): Promise<void> {
    for await (const status of connection.status()) {
        if (status.type !== 'reconnect') continue
        let delay = 250
        while (!stopping() && !connection.isClosed()) {
            try {
                await ensureCodeverStreams(manager)
                break
            } catch (error) {
                console.error('Unable to reconcile Codever JetStream topology after reconnect', error)
                await new Promise(resolve => setTimeout(resolve, delay))
                delay = Math.min(delay * 2, 10_000)
            }
        }
    }
}

export async function ensureCodeverStreams(manager: JetStreamManager): Promise<void> {
    const existing = new Set<string>()
    for await (const name of manager.streams.names()) existing.add(name)
    for (const spec of CODEVER_STREAM_TOPOLOGY) {
        if (existing.has(spec.name)) await manager.streams.update(spec.name, spec)
        else await manager.streams.add(spec)
    }
}
