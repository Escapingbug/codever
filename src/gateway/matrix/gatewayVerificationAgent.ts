import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MatrixTransport, NativeMatrixVerification } from './nativeMatrixTransport'

export interface GatewayVerificationStatus {
    version: 1
    updatedAt: string
    flows: NativeMatrixVerification[]
}

interface GatewayVerificationDecision {
    version: 1
    flowId: string
    matches: boolean
}

export class GatewayVerificationAgent {
    private timer?: ReturnType<typeof setInterval>
    private ticking = false

    constructor(
        private readonly transport: MatrixTransport,
        private readonly directory: string,
        private readonly onError: (error: Error) => void = () => undefined,
    ) {}

    async start(): Promise<void> {
        if (this.timer) return
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        await this.tick()
        this.timer = setInterval(() => void this.tick(), 500)
    }

    async stop(): Promise<void> {
        if (this.timer) clearInterval(this.timer)
        this.timer = undefined
        await rm(gatewayVerificationStatusPath(this.directory), { force: true })
    }

    private async tick(): Promise<void> {
        if (this.ticking) return
        this.ticking = true
        try {
            const list = this.transport.listVerifications
            const advance = this.transport.advanceVerification
            const confirm = this.transport.confirmVerification
            if (!list || !advance || !confirm) {
                await this.writeStatus([])
                return
            }
            const flows: NativeMatrixVerification[] = []
            for (const current of await list.call(this.transport)) {
                let flow = current
                if (!['done', 'cancelled', 'unsupported'].includes(flow.stage)) {
                    flow = await advance.call(this.transport, flow.flowId)
                }
                const decision = await readDecision(this.directory, flow.flowId)
                if (decision && flow.stage === 'present_sas') {
                    flow = await confirm.call(this.transport, flow.flowId, decision.matches)
                    await rm(gatewayVerificationDecisionPath(this.directory, flow.flowId), { force: true })
                }
                flows.push(flow)
            }
            await this.writeStatus(flows)
        } catch (error) {
            this.onError(error instanceof Error ? error : new Error(String(error)))
        } finally {
            this.ticking = false
        }
    }

    private async writeStatus(flows: NativeMatrixVerification[]): Promise<void> {
        const status: GatewayVerificationStatus = {
            version: 1,
            updatedAt: new Date().toISOString(),
            flows,
        }
        const target = gatewayVerificationStatusPath(this.directory)
        const temporary = `${target}.${process.pid}.tmp`
        await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        await replaceFile(temporary, target)
    }
}

export function gatewayVerificationDirectory(dataDirectory: string): string {
    return join(dataDirectory, 'matrix-verification')
}

export function gatewayVerificationStatusPath(directory: string): string {
    return join(directory, 'status.json')
}

export function gatewayVerificationDecisionPath(directory: string, flowId: string): string {
    return join(directory, `${encodeURIComponent(flowId)}.decision.json`)
}

export async function readGatewayVerificationStatus(directory: string): Promise<GatewayVerificationStatus | undefined> {
    try {
        const value = JSON.parse(await readFile(gatewayVerificationStatusPath(directory), 'utf8')) as GatewayVerificationStatus
        if (value.version !== 1 || !Array.isArray(value.flows) || Number.isNaN(Date.parse(value.updatedAt))) return undefined
        return value
    } catch {
        return undefined
    }
}

export async function writeGatewayVerificationDecision(
    directory: string,
    flowId: string,
    matches: boolean,
): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const decision: GatewayVerificationDecision = { version: 1, flowId, matches }
    const target = gatewayVerificationDecisionPath(directory, flowId)
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(decision, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await replaceFile(temporary, target)
}

async function replaceFile(temporary: string, target: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            await rename(temporary, target)
            return
        } catch (error) {
            const code = isNodeError(error) ? error.code : undefined
            if (attempt >= 5 || (code !== 'EPERM' && code !== 'EACCES')) throw error
            await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
        }
    }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
    return value instanceof Error && 'code' in value
}

async function readDecision(directory: string, flowId: string): Promise<GatewayVerificationDecision | undefined> {
    try {
        const value = JSON.parse(await readFile(gatewayVerificationDecisionPath(directory, flowId), 'utf8')) as GatewayVerificationDecision
        return value.version === 1 && value.flowId === flowId && typeof value.matches === 'boolean' ? value : undefined
    } catch {
        return undefined
    }
}
