import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runGatewayDevicePairCommand, startGatewayLocalControlServer } from '../localControl'

describe('Gateway local control', () => {
    it('asks the running Gateway process to issue the device pairing ticket', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-gateway-control-'))
        const ticket = {
            pairingId: 'ABC234',
            code: 'ABC234-DEFGH-JKLMN',
            expiresAt: new Date(Date.now() + 180_000).toISOString(),
            attemptsRemaining: 5,
        }
        let issues = 0
        const server = await startGatewayLocalControlServer(directory, () => {
            issues += 1
            return ticket
        })

        await expect(runGatewayDevicePairCommand(directory)).resolves.toEqual(ticket)
        expect(issues).toBe(1)
        await server.close()
    })
})
