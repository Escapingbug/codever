import { pathToFileURL } from 'node:url'
import { activateMacosGatewayRelease } from '../src/ops/macosGatewayRelease.js'

function requiredArgument(name: string): string {
    const index = process.argv.indexOf(`--${name}`)
    const value = index >= 0 ? process.argv[index + 1] : undefined
    if (!value) throw new Error(`Missing --${name}`)
    return value
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await activateMacosGatewayRelease({
        releaseDirectory: requiredArgument('release'),
        installRoot: requiredArgument('install-root'),
        launchAgentPath: requiredArgument('launch-agent'),
        serviceLabel: requiredArgument('service-label'),
        adminSocketPath: requiredArgument('admin-socket'),
    })
    process.stdout.write('Matrix Gateway release is running and healthy.\n')
}
