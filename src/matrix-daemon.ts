import {
    V3MatrixGatewayRunner,
    type MatrixGatewayConfig,
    type V3MatrixGatewayDependencies,
} from '@/gateway/matrix'

/**
 * Programmatic Matrix daemon entry. Credentials and trusted device keys are
 * deliberately supplied as a configuration object by the desktop installer or
 * service host; this module never falls back to ambient Telegram config.
 */
export async function startMatrixDaemon(
    config: MatrixGatewayConfig,
    dependencies: V3MatrixGatewayDependencies = {},
): Promise<V3MatrixGatewayRunner> {
    const runner = new V3MatrixGatewayRunner(config, dependencies)
    await runner.start()
    return runner
}
