import type { FastifyRequest } from 'fastify'
import type { ClientAction, ClientAuthenticator, ClientAuthorizationTarget, ClientIdentity } from './auth'
import { DenyAllClientAuthenticator, EcdsaP256GatewayAuthenticator } from './auth'
import { loadRelayConfig, StaticEnrolledGatewayKeyRepository } from './config'
import { createDurableRelayRepositories } from './durableRepositories'
import { createInMemoryRelayRepositories } from './memoryRepositories'
import { createRelayServer } from './server'

class InsecureDevelopmentClientAuthenticator implements ClientAuthenticator {
    constructor(private readonly workspaceId: string) {}

    async authenticate(_request: FastifyRequest): Promise<ClientIdentity> {
        return { id: 'insecure-development-user', workspaceId: this.workspaceId, deviceId: 'insecure-development-device' }
    }

    async authorize(
        _identity: ClientIdentity,
        _action: ClientAction,
        _target: ClientAuthorizationTarget,
    ): Promise<true> {
        return true
    }
}

const config = await loadRelayConfig()
const repositories = config.repositoryMode === 'memory'
    ? createInMemoryRelayRepositories()
    : await createDurableRelayRepositories(config.dataDirectory)
const clientAuthenticator = config.insecureDevAuth
    ? new InsecureDevelopmentClientAuthenticator(config.devWorkspaceId)
    : new DenyAllClientAuthenticator()
if (config.insecureDevAuth) {
    process.stderr.write('WARNING: CODEVER_RELAY_INSECURE_DEV_AUTH=true; all client requests are authorized.\n')
}
if (config.repositoryMode === 'memory') {
    process.stderr.write('WARNING: CODEVER_RELAY_REPOSITORY_MODE=memory; all Relay state will be lost at process exit.\n')
}

const app = await createRelayServer({
    relayId: config.relayId,
    logger: config.logger,
    clientAuthenticator,
    gatewayAuthenticator: new EcdsaP256GatewayAuthenticator(
        new StaticEnrolledGatewayKeyRepository(config.gateways),
    ),
    repositories,
    ...(config.tls && { https: { cert: config.tls.cert, key: config.tls.key } }),
})

const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down Relay')
    await app.close()
}
process.once('SIGINT', () => { void shutdown('SIGINT') })
process.once('SIGTERM', () => { void shutdown('SIGTERM') })

await app.listen({ host: config.host, port: config.port })
