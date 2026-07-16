import type { FastifyRequest } from 'fastify'
import { join } from 'node:path'
import type { ClientAction, ClientAuthenticator, ClientAuthorizationTarget, ClientIdentity } from './auth'
import { EcdsaP256GatewayAuthenticator } from './auth'
import { AuthSessionRepository, BearerAccountAuthenticator } from './accountAuth'
import { loadRelayConfig } from './config'
import { createDurableRelayRepositories } from './durableRepositories'
import { createInMemoryRelayRepositories } from './memoryRepositories'
import { createRelayServer } from './server'
import { GatewayEnrollmentRepository } from './enrollmentRepository'
import { runLocalControlCommand, startLocalControlServer } from './localControl'

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
if (process.argv[2] === 'enrollment') {
    const result = await runLocalControlCommand(config.dataDirectory, process.argv.slice(3))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exit(0)
}
const repositories = config.repositoryMode === 'memory'
    ? createInMemoryRelayRepositories()
    : await createDurableRelayRepositories(config.dataDirectory)
const accountAuthenticator = config.insecureDevAuth
    ? undefined
    : new BearerAccountAuthenticator({
        users: config.users,
        sessions: await AuthSessionRepository.open(join(config.dataDirectory, 'auth-sessions.json')),
        gateways: repositories.gateways,
        sessionTtlSeconds: config.sessionTtlSeconds,
    })
const clientAuthenticator = config.insecureDevAuth
    ? new InsecureDevelopmentClientAuthenticator(config.devWorkspaceId)
    : accountAuthenticator!
const enrollmentRepository = await GatewayEnrollmentRepository.open({
    ...(config.repositoryMode === 'durable' && { path: join(config.dataDirectory, 'gateway-enrollments.json') }),
    initialGateways: config.gateways,
})
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
    ...(accountAuthenticator && { accountService: accountAuthenticator }),
    gatewayAuthenticator: new EcdsaP256GatewayAuthenticator(
        enrollmentRepository,
    ),
    enrollmentRepository,
    repositories,
    ...(config.tls && { https: { cert: config.tls.cert, key: config.tls.key } }),
})
const localControl = await startLocalControlServer(config.dataDirectory, enrollmentRepository)

const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down Relay')
    await localControl.close()
    await app.close()
}
process.once('SIGINT', () => { void shutdown('SIGINT') })
process.once('SIGTERM', () => { void shutdown('SIGTERM') })

await app.listen({ host: config.host, port: config.port })
