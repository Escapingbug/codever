import {
    MatrixGatewayRunner,
    type MatrixGatewayConfig,
    type MatrixGatewayDependencies,
} from '@/gateway/matrix'

/**
 * Programmatic Matrix daemon entry. Credentials and trusted device keys are
 * deliberately supplied as a configuration object by the desktop installer or
 * service host; this module never falls back to ambient Telegram config.
 */
export async function startMatrixDaemon(
    config: MatrixGatewayConfig,
    dependencies: MatrixGatewayDependencies = {},
): Promise<MatrixGatewayRunner> {
    const runner = new MatrixGatewayRunner(config, dependencies)
    await runner.start()
    return runner
}
