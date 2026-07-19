import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    GatewayVerificationAgent, gatewayVerificationStatusPath,
    readGatewayVerificationStatus, writeGatewayVerificationDecision,
} from '../gatewayVerificationAgent'
import type { MatrixTransport, NativeMatrixVerification } from '../nativeMatrixTransport'

describe('GatewayVerificationAgent', () => {
    const directories: string[] = []
    afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))))

    it('advances a live incoming SAS flow but requires an explicit local decision', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-verification-'))
        directories.push(directory)
        const transport = new VerificationTransport()
        const agent = new GatewayVerificationAgent(transport, directory)
        await agent.start()

        await vi.waitFor(async () => {
            expect((await readGatewayVerificationStatus(directory))?.flows[0]?.stage).toBe('present_sas')
        })
        expect(transport.confirmations).toEqual([])

        await writeGatewayVerificationDecision(directory, 'flow-1', true)
        await vi.waitFor(async () => {
            expect(transport.confirmations).toEqual([true])
            expect((await readGatewayVerificationStatus(directory))?.flows[0]?.stage).toBe('done')
        })
        await agent.stop()
        await expect(readFile(gatewayVerificationStatusPath(directory), 'utf8')).rejects.toThrow()
    })
})

class VerificationTransport implements MatrixTransport {
    readonly confirmations: boolean[] = []
    private stage: NativeMatrixVerification['stage'] = 'requested'
    async initialize(): Promise<void> {}
    async send(): Promise<string> { return '$event' }
    onEvent(): () => void { return () => undefined }
    async close(): Promise<void> {}
    async listVerifications(): Promise<NativeMatrixVerification[]> { return [this.snapshot()] }
    async advanceVerification(): Promise<NativeMatrixVerification> {
        this.stage = this.stage === 'requested' ? 'ready' : 'present_sas'
        return this.snapshot()
    }
    async confirmVerification(_flowId: string, matches: boolean): Promise<NativeMatrixVerification> {
        this.confirmations.push(matches)
        this.stage = matches ? 'done' : 'cancelled'
        return this.snapshot()
    }
    private snapshot(): NativeMatrixVerification {
        return {
            flowId: 'flow-1', stage: this.stage, otherDeviceId: 'PHONE',
            ...(this.stage === 'present_sas' ? { emojis: [{ symbol: '🐶', description: 'Dog' }] } : {}),
        }
    }
}
