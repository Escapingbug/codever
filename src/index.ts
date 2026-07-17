import { parseArgs } from 'node:util'
import { createGatewayApplication, defaultGatewayConfigPath, loadGatewayConfig, writeGatewayConfig } from './gateway/index.js'

async function main(): Promise<void> {
    const { positionals, values } = parseArgs({
        allowPositionals: true,
        options: {
            config: { type: 'string', short: 'c' },
            relay: { type: 'string' },
            root: { type: 'string', multiple: true },
            path: { type: 'string' },
            name: { type: 'string' },
            workspace: { type: 'string' },
            id: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
    })
    const command = positionals[0]
    const configPath = values.config ?? defaultGatewayConfigPath()
    if (values.help || !command) return help()

    if (command === 'init') {
        if (!values.relay || !values.root?.length) throw new Error('init requires --relay and at least one --root')
        const config = await writeGatewayConfig({
            name: values.name ?? process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'Codever Gateway',
            relayUrl: values.relay,
            allowedRoots: values.root,
            ...(values.workspace ? { workspaceId: values.workspace } : {}),
        }, configPath)
        console.log(`Gateway config written: ${configPath}`)
        console.log(`Gateway ID: ${config.gatewayId}`)
        return
    }

    const config = await loadGatewayConfig(configPath)
    const application = await createGatewayApplication(config)
    if (command === 'enrollment') {
        console.log(JSON.stringify({ gatewayId: config.gatewayId, name: config.name, identity: application.identity.enrollmentBundle() }, null, 2))
        await application.close()
        return
    }
    if (command === 'project') {
        const subcommand = positionals[1]
        if (subcommand === 'add') {
            if (!values.path) throw new Error('project add requires --path')
            const project = await application.projects.create({
                name: values.name ?? values.path,
                rootPath: values.path,
            })
            console.log(JSON.stringify(project, null, 2))
        } else if (subcommand === 'list') {
            console.log(JSON.stringify(await application.projects.list({ includeArchived: true }), null, 2))
        } else {
            throw new Error('project requires add or list')
        }
        await application.close()
        return
    }
    if (command === 'device') {
        const subcommand = positionals[1]
        if (subcommand === 'pair') {
            console.log(JSON.stringify(application.issueDevicePairing(), null, 2))
        } else if (subcommand === 'list') {
            console.log(JSON.stringify(await application.listDevices(), null, 2))
        } else if (subcommand === 'revoke') {
            if (!values.id) throw new Error('device revoke requires --id')
            console.log(JSON.stringify({ credentialId: values.id, revoked: await application.revokeDevice(values.id) }, null, 2))
        } else {
            throw new Error('device requires pair, list, or revoke')
        }
        await application.close()
        return
    }
    if (command !== 'start') throw new Error(`Unknown command: ${command}`)

    application.start()
    console.log(`Gateway ${config.name} (${config.gatewayId}) connecting to ${config.relayUrl}`)
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
  codever init --relay <wss-url> --root <absolute-path> [--root ...] [--name <name>]
  codever enrollment [-c <config>]   Print the public enrollment bundle (never the private key)
  codever project add --path <absolute-path> [--name <name>]
  codever project list [-c <config>]
  codever device pair [-c <config>]  Issue a one-time 3-minute client pairing code
  codever device list [-c <config>]  List Gateway-owned client credentials
  codever device revoke --id <credential-id> [-c <config>]
  codever start [-c <config>]        Run the outbound Gateway service
`)
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
})
