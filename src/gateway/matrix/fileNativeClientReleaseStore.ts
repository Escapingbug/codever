import { AtomicJsonFile } from '@codever/security/node'
import {
  nativeClientReleaseSchema,
  type NativeClientRelease,
} from '@codever/protocol'

interface NativeClientReleaseState {
  version: 1
  workspaceId: string
  releases: NativeClientRelease[]
}

export interface NativeClientReleasePublishResult {
  changed: boolean
  release: NativeClientRelease
  releases: NativeClientRelease[]
}

/** Durable account-scoped latest releases published through the local Gateway. */
export class FileNativeClientReleaseStore {
  private readonly file: AtomicJsonFile<NativeClientReleaseState>

  constructor(
    path: string,
    private readonly workspaceId: string,
  ) {
    this.file = new AtomicJsonFile(path)
  }

  initialize(): Promise<void> {
    return this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        return { result: undefined, changed: false }
      },
    )
  }

  releases(): Promise<NativeClientRelease[]> {
    return this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        return { result: structuredClone(state.releases), changed: false }
      },
    )
  }

  publish(input: NativeClientRelease): Promise<NativeClientReleasePublishResult> {
    const release = nativeClientReleaseSchema.parse(input)
    return this.file.transaction<NativeClientReleasePublishResult>(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        const index = state.releases.findIndex(candidate =>
          candidate.platform === release.platform
          && candidate.channel === release.channel
          && candidate.architecture === release.architecture
        )
        const current = index < 0 ? undefined : state.releases[index]
        if (current && release.versionCode < current.versionCode) {
          throw new Error(
            `Native ${release.platform}/${release.channel} release cannot move backward `
            + `from ${current.versionCode} to ${release.versionCode}`,
          )
        }
        if (current && release.versionCode === current.versionCode) {
          if (JSON.stringify(current) !== JSON.stringify(release)) {
            throw new Error(
              `Native release ${release.platform}/${release.channel}/${release.versionCode} `
              + 'is immutable',
            )
          }
          return {
            result: {
              changed: false,
              release: structuredClone(current),
              releases: structuredClone(state.releases),
            },
            changed: false,
          }
        }
        if (index < 0) state.releases.push(structuredClone(release))
        else state.releases[index] = structuredClone(release)
        state.releases.sort((left, right) =>
          `${left.platform}\u0000${left.channel}\u0000${left.architecture}`.localeCompare(
            `${right.platform}\u0000${right.channel}\u0000${right.architecture}`,
          ),
        )
        return {
          result: {
            changed: true,
            release: structuredClone(release),
            releases: structuredClone(state.releases),
          },
          changed: true,
        }
      },
    )
  }
}

function defaultState(workspaceId: string): NativeClientReleaseState {
  return { version: 1, workspaceId, releases: [] }
}

function validateState(value: NativeClientReleaseState, workspaceId: string): void {
  if (
    value.version !== 1
    || value.workspaceId !== workspaceId
    || !Array.isArray(value.releases)
    || value.releases.length > 8
  ) {
    throw new Error('Invalid native client release state')
  }
  const releases = value.releases.map(release => nativeClientReleaseSchema.parse(release))
  const keys = releases.map(release =>
    `${release.platform}\u0000${release.channel}\u0000${release.architecture}`
  )
  if (new Set(keys).size !== keys.length) {
    throw new Error('Native client release state contains duplicate channels')
  }
}
