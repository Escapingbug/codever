import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
    GATEWAY_STATE_CATALOG,
    type GatewayStateCatalogEntry,
} from '@/gateway/matrix/stateUpgradeCatalog'

interface ReleasedGatewayStore {
    id: string
    stateClass: GatewayStateCatalogEntry['stateClass']
    schemaVersion: number
}

describe('Gateway release state catalog', () => {
    it('keeps every released store and every adjacent protected migration', async () => {
        const released = JSON.parse(await readFile(
            new URL('./fixtures/gateway-state-catalog-v1.json', import.meta.url),
            'utf8',
        )) as ReleasedGatewayStore[]

        for (const previous of released) {
            const current = GATEWAY_STATE_CATALOG.find(entry => entry.id === previous.id)
            expect(current, `${previous.id} was removed without a retirement migration`).toBeDefined()
            expect(current?.stateClass, `${previous.id} changed safety class`).toBe(previous.stateClass)
            expect(current?.schemaVersion, `${previous.id} was downgraded`).toBeGreaterThanOrEqual(
                previous.schemaVersion,
            )
            if (
                previous.stateClass === 'security-critical'
                || previous.stateClass === 'durable-command'
            ) {
                for (
                    let version = previous.schemaVersion;
                    version < (current?.schemaVersion ?? 0);
                    version += 1
                ) {
                    expect(
                        current?.migrationFromVersions.has(version),
                        `${previous.id} has no ${version} -> ${version + 1} migration`,
                    ).toBe(true)
                }
            }
        }
    })

    it('has unique valid current entries', () => {
        expect(new Set(GATEWAY_STATE_CATALOG.map(entry => entry.id)).size)
            .toBe(GATEWAY_STATE_CATALOG.length)
        for (const entry of GATEWAY_STATE_CATALOG) {
            expect(entry.schemaVersion).toBeGreaterThanOrEqual(1)
            for (const version of entry.migrationFromVersions) {
                expect(version).toBeGreaterThanOrEqual(1)
                expect(version).toBeLessThan(entry.schemaVersion)
            }
        }
    })
})
