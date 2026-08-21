import {
    MatrixCvp3GatewayRunner,
    type MatrixGatewayConfig,
    type MatrixCvp3GatewayDependencies,
} from '@/gateway/matrix'

/**
 * Programmatic Matrix daemon entry. Credentials and trusted device keys are
 * deliberately supplied as a configuration object by the desktop installer or
 * service host; this module never falls back to ambient Telegram config.
 */
export async function startMatrixDaemon(
    config: MatrixGatewayConfig,
    dependencies: MatrixCvp3GatewayDependencies = {},
): Promise<MatrixCvp3GatewayRunner> {
    const runner = new MatrixCvp3GatewayRunner(config, dependencies)
    await runner.start()
    return runner
}
