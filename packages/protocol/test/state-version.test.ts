import { describe, expect, it } from 'vitest'
import {
  MissingStateMigrationError,
  UnsupportedStateVersionError,
  migrateVersionedState,
} from '../src/state-version.js'

describe('versioned persisted state', () => {
  it('runs every adjacent migration exactly once', () => {
    const result = migrateVersionedState({
      label: 'fixture',
      value: { version: 0, retained: 'identity' },
      currentVersion: 2,
      migrations: {
        0: value => ({ ...value, version: 1, projection: 'reset' }),
        1: value => ({ ...value, version: 2, command: 'recover' }),
      },
    })
    expect(result).toEqual({
      migratedFrom: 0,
      value: {
        version: 2,
        retained: 'identity',
        projection: 'reset',
        command: 'recover',
      },
    })
    expect(migrateVersionedState({
      label: 'fixture',
      value: result.value,
      currentVersion: 2,
      migrations: {},
    }).migratedFrom).toBeNull()
  })

  it('fails closed for future state and missing migration steps', () => {
    expect(() => migrateVersionedState({
      label: 'fixture',
      value: { version: 3 },
      currentVersion: 2,
      migrations: {},
    })).toThrow(UnsupportedStateVersionError)
    expect(() => migrateVersionedState({
      label: 'fixture',
      value: { version: 0 },
      currentVersion: 1,
      migrations: {},
    })).toThrow(MissingStateMigrationError)
  })

  it('rejects a migration that skips a version', () => {
    expect(() => migrateVersionedState({
      label: 'fixture',
      value: { version: 0 },
      currentVersion: 2,
      migrations: { 0: value => ({ ...value, version: 2 }) },
    })).toThrow('must produce schema 1')
  })
})
