import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadRelayConfig } from './config'
import { runLocalPairCommand, startLocalControlServer } from './localControl'
import { SecureClientAuthenticator } from './secureClientAuth'
import { OpaqueSetupRepository } from './opaqueSetupRepository'
import { SecureGatewayAuthenticator } from './secureGatewayAuth'
import { createRelayServer } from './server'
import { startCodeverJetStream } from './jetstream'
import { NscCredentialIssuer } from './nscCredentialIssuer'

const config = await loadRelayConfig()
if (process.argv[2] === 'pair') {
    const target = process.argv[3]
    if (target !== 'gateway' && target !== 'client') {
        throw new Error('Usage: codever-relay pair <gateway|client>')
    }
    const result = await runLocalPairCommand(config.dataDirectory, target)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exit(0)
}

const natsCredentials = config.natsCredentialsFile ? await readFile(config.natsCredentialsFile) : undefined
const jetstream = await startCodeverJetStream(config.natsUrl, natsCredentials)

const gatewayOpaque = await OpaqueSetupRepository.open(
    join(config.dataDirectory, 'gateway-opaque-setup.json'),
)
const clientOpaque = await OpaqueSetupRepository.open(
    join(config.dataDirectory, 'client-opaque-setup.json'),
)
const natsCredentialIssuer = new NscCredentialIssuer({
    storeDirectory: config.nscStoreDirectory,
    keysDirectory: config.nscKeysDirectory,
    configDirectory: config.nscConfigDirectory,
    operator: config.nscOperator,
    account: config.nscAccount,
    websocketUrl: config.natsWebSocketUrl,
    natsUrl: config.natsGatewayUrl,
    executable: config.nscExecutable,
    jetstreamManager: jetstream.manager,
})
const secureGatewayAuthenticator = await SecureGatewayAuthenticator.create({
    relayId: config.relayId,
    serverSetup: gatewayOpaque.serverSetup,
    natsCredentials: natsCredentialIssuer,
})
const secureClientAuthenticator = await SecureClientAuthenticator.create({
    relayId: config.relayId,
    serverSetup: clientOpaque.serverSetup,
    natsCredentials: natsCredentialIssuer,
})
const app = await createRelayServer({
    logger: config.logger,
    secureGatewayAuthenticator,
    secureClientAuthenticator,
})
const localControl = await startLocalControlServer(
    config.dataDirectory,
    secureGatewayAuthenticator,
    secureClientAuthenticator,
)

const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down Relay')
    await localControl.close()
    await app.close()
    await jetstream.close()
}
process.once('SIGINT', () => { void shutdown('SIGINT') })
process.once('SIGTERM', () => { void shutdown('SIGTERM') })

await app.listen({ host: config.host, port: config.port })
