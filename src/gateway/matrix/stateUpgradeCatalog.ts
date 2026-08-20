import type { PersistedStateClass } from '@codever/protocol'
import {
    GATEWAY_RUNTIME_STATE_MIGRATIONS,
    GATEWAY_RUNTIME_STATE_SCHEMA_VERSION,
} from './fileRuntimeState.js'

export interface GatewayStateCatalogEntry {
    id: string
    stateClass: PersistedStateClass
    schemaVersion: number
    /** Every N denotes decoder/migration support for N -> N+1. */
    migrationFromVersions: ReadonlySet<number>
}

/**
 * Release inventory for every Gateway-owned persistent family. File/WAL
 * codecs retain their own atomic commit boundary; this catalog is the common
 * release gate that prevents a future schema bump from dropping an adjacent
 * migration or silently changing its safety class.
 */
export const GATEWAY_STATE_CATALOG: readonly GatewayStateCatalogEntry[] = Object.freeze([
    {
        id: 'gateway-runtime-state',
        stateClass: 'durable-command',
        schemaVersion: GATEWAY_RUNTIME_STATE_SCHEMA_VERSION,
        migrationFromVersions: migrationKeys(GATEWAY_RUNTIME_STATE_MIGRATIONS),
    },
    {
        id: 'command-replay-ledger',
        stateClass: 'security-critical',
        schemaVersion: 2,
        migrationFromVersions: new Set<number>(),
    },
    {
        id: 'timeline-key-ring',
        stateClass: 'security-critical',
        schemaVersion: 1,
        migrationFromVersions: new Set<number>(),
    },
    {
        id: 'matrix-login',
        stateClass: 'security-critical',
        schemaVersion: 1,
        migrationFromVersions: new Set<number>(),
    },
    {
        id: 'matrix-sdk-crypto-store',
        stateClass: 'security-critical',
        schemaVersion: 1,
        migrationFromVersions: new Set<number>(),
    },
    {
        id: 'matrix-state-outbox-wal',
        stateClass: 'durable-command',
        schemaVersion: 1,
        migrationFromVersions: new Set<number>(),
    },
    {
        id: 'matrix-delivery-outbox-wal',
        stateClass: 'durable-command',
        schemaVersion: 2,
        // The v2 decoder deliberately retains v1 single-recipient records.
        migrationFromVersions: new Set([1]),
    },
    {
        id: 'matrix-sync-cursor',
        stateClass: 'rebuildable-projection',
        schemaVersion: 1,
        migrationFromVersions: new Set<number>(),
    },
])

function migrationKeys(
    migrations: Readonly<Record<number, unknown>>,
): ReadonlySet<number> {
    return new Set(
        Object.entries(migrations)
            .filter(([, migration]) => typeof migration === 'function')
            .map(([version]) => Number(version)),
    )
}
