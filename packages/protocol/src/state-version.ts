export type PersistedStateClass =
  | 'security-critical'
  | 'durable-command'
  | 'rebuildable-projection'
  | 'ephemeral-ui'

export type VersionedState = Readonly<Record<string, unknown>> & {
  version: number
}

export type StateMigration = (value: VersionedState) => VersionedState

export class UnsupportedStateVersionError extends Error {
  constructor(
    readonly label: string,
    readonly foundVersion: number,
    readonly currentVersion: number,
  ) {
    super(
      `${label} uses schema ${foundVersion}, but this build supports schemas up to ${currentVersion}.`,
    )
    this.name = 'UnsupportedStateVersionError'
  }
}

export class MissingStateMigrationError extends Error {
  constructor(
    readonly label: string,
    readonly fromVersion: number,
    readonly toVersion: number,
  ) {
    super(`${label} has no registered migration from schema ${fromVersion} to ${toVersion}.`)
    this.name = 'MissingStateMigrationError'
  }
}

/**
 * Applies explicit, adjacent schema migrations. Every step must advance by
 * exactly one version so a release cannot silently skip an untested upgrade.
 * The function is deterministic and side-effect free; callers own the
 * crash-safe journal and atomic commit appropriate for their storage medium.
 */
export function migrateVersionedState(input: {
  label: string
  value: VersionedState
  currentVersion: number
  migrations: Readonly<Record<number, StateMigration | undefined>>
}): { value: VersionedState; migratedFrom: number | null } {
  const { label, currentVersion, migrations } = input
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 0) {
    throw new Error(`${label} current schema version is invalid.`)
  }
  let value = requireVersionedState(label, input.value)
  if (value.version > currentVersion) {
    throw new UnsupportedStateVersionError(label, value.version, currentVersion)
  }
  const migratedFrom = value.version === currentVersion ? null : value.version
  while (value.version < currentVersion) {
    const fromVersion = value.version
    const migration = migrations[fromVersion]
    if (!migration) {
      throw new MissingStateMigrationError(label, fromVersion, fromVersion + 1)
    }
    const migrated = requireVersionedState(label, migration(value))
    if (migrated.version !== fromVersion + 1) {
      throw new Error(
        `${label} migration ${fromVersion} must produce schema ${fromVersion + 1}.`,
      )
    }
    value = migrated
  }
  return { value, migratedFrom }
}

function requireVersionedState(label: string, value: unknown): VersionedState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a versioned object.`)
  }
  const version = (value as Record<string, unknown>).version
  if (!Number.isSafeInteger(version) || (version as number) < 0) {
    throw new Error(`${label} schema version is invalid.`)
  }
  return value as VersionedState
}
