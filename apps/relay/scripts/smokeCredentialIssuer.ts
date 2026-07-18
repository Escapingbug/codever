import { readFile } from 'node:fs/promises'
import {
    CODEVER_STREAMS,
    gatewayConsumerName,
    gatewayObjectStreamName,
    gatewayPairingRequestsSubject,
    gatewayPresenceSubject,
} from '@codever/protocol'
import { jetstreamManager } from '@nats-io/jetstream'
import { Objm } from '@nats-io/obj'
import { connect, credsAuthenticator, jwtAuthenticator, nkeys } from '@nats-io/transport-node'
import { NscCredentialIssuer } from '../src/nscCredentialIssuer'

const url = process.env.CODEVER_RELAY_NATS_URL ?? 'nats://nats:4222'
const root = process.env.CODEVER_SECURITY_ROOT ?? '/data/security'
const gatewayId = `smoke_gateway_${Date.now()}`
const clientId = `smoke_client_${Date.now()}`
const admin = await connect({
    servers: [url],
    authenticator: credsAuthenticator(await readFile(`${root}/relay-admin.creds`)),
})

try {
    const manager = await jetstreamManager(admin)
    const issuer = new NscCredentialIssuer({
        configDirectory: `${root}/config`,
        storeDirectory: `${root}/store`,
        keysDirectory: `${root}/keys`,
        operator: 'CODEVER',
        account: 'CODEVER',
        websocketUrl: 'ws://nats:8080',
        natsUrl: url,
        jetstreamManager: manager,
    })

    const gatewayKey = nkeys.createUser()
    const gatewayCredential = await issuer.issueGateway(gatewayId, gatewayKey.getPublicKey())
    const gateway = await connect({
        servers: [url],
        authenticator: jwtAuthenticator(gatewayCredential.userJwt, gatewayKey.getSeed()),
    })
    try {
        const pairingSubscription = gateway.subscribe(gatewayPairingRequestsSubject(gatewayId))
        await gateway.flush()
        pairingSubscription.unsubscribe()
        gateway.publish(gatewayPresenceSubject(gatewayId), new TextEncoder().encode('{"smoke":true}'))
        await gateway.flush()
        const bucket = await new Objm(gateway).open(`CV_${gatewayId}`)
        await bucket.putBlob({ name: 'smoke' }, new TextEncoder().encode('encrypted-smoke'))
        const value = await bucket.getBlob('smoke')
        if (new TextDecoder().decode(value) !== 'encrypted-smoke') throw new Error('Object Store roundtrip failed')
        await bucket.delete('smoke')
    } finally {
        gatewayKey.clear()
        await gateway.close()
    }

    const clientKey = nkeys.createUser()
    const clientCredential = await issuer.issueClient(clientId, clientKey.getPublicKey())
    const client = await connect({
        servers: [url],
        authenticator: jwtAuthenticator(clientCredential.userJwt, clientKey.getSeed()),
    })
    clientKey.clear()
    await client.close()

    await manager.consumers.info(CODEVER_STREAMS.commands, gatewayConsumerName(gatewayId))
    await manager.streams.info(gatewayObjectStreamName(gatewayId))
    process.stdout.write(JSON.stringify({ gatewayId, clientId, status: 'ok' }) + '\n')
} finally {
    await admin.close()
}
