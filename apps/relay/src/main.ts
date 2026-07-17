import { join } from 'node:path'
import { ClientCredentialRepository } from './clientCredentialRepository'
import { loadRelayConfig } from './config'
import { createDurableRelayRepositories } from './durableRepositories'
import { runLocalPairCommand, startLocalControlServer } from './localControl'
import { createInMemoryRelayRepositories } from './memoryRepositories'
import { SecureClientAuthenticator } from './secureClientAuth'
import { SecureCredentialRepository } from './secureCredentialRepository'
import { SecureGatewayAuthenticator } from './secureGatewayAuth'
import { createRelayServer } from './server'

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

const repositories = config.repositoryMode === 'memory'
    ? createInMemoryRelayRepositories()
    : await createDurableRelayRepositories(config.dataDirectory)
const gatewayCredentials = await SecureCredentialRepository.open(
    join(config.dataDirectory, 'secure-gateway-credentials.json'),
)
for (const gateway of await repositories.gateways.list()) {
    const credential = await gatewayCredentials.get(gateway.id)
    if (!credential?.enabled) await repositories.gateways.remove(gateway.id)
}
const clientCredentials = await ClientCredentialRepository.open(
    join(config.dataDirectory, 'secure-client-credentials.json'),
)
const secureGatewayAuthenticator = await SecureGatewayAuthenticator.create({
    relayId: config.relayId,
    serverSetup: gatewayCredentials.serverSetup,
    credentials: gatewayCredentials,
})
const secureClientAuthenticator = await SecureClientAuthenticator.create({
    relayId: config.relayId,
    serverSetup: clientCredentials.serverSetup,
    credentials: clientCredentials,
})
if (config.repositoryMode === 'memory') {
    process.stderr.write('WARNING: CODEVER_RELAY_REPOSITORY_MODE=memory; Gateway metadata will be lost at process exit.\n')
}

const app = await createRelayServer({
    logger: config.logger,
    secureGatewayAuthenticator,
    secureClientAuthenticator,
    repositories,
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
}
process.once('SIGINT', () => { void shutdown('SIGINT') })
process.once('SIGTERM', () => { void shutdown('SIGTERM') })

await app.listen({ host: config.host, port: config.port })
