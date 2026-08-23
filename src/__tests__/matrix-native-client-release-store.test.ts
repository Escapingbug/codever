import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileNativeClientReleaseStore } from '@/gateway/matrix/fileNativeClientReleaseStore'

describe('FileNativeClientReleaseStore', () => {
  it('persists one immutable latest release per account channel', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-native-release-'))
    const path = join(directory, 'releases.json')
    const store = new FileNativeClientReleaseStore(path, 'workspace-1')
    await store.initialize()

    await expect(store.publish(release(42))).resolves.toMatchObject({ changed: true })
    await expect(store.publish(release(42))).resolves.toMatchObject({ changed: false })
    await expect(store.publish({
      ...release(42),
      artifact: { ...release(42).artifact, sha256: 'c'.repeat(64) },
    })).rejects.toThrow(/immutable/)
    await expect(store.publish(release(41))).rejects.toThrow(/cannot move backward/)
    await expect(store.publish(release(43))).resolves.toMatchObject({ changed: true })

    const recovered = new FileNativeClientReleaseStore(path, 'workspace-1')
    await recovered.initialize()
    await expect(recovered.releases()).resolves.toMatchObject([{ versionCode: 43 }])
  })
})

function release(versionCode: number) {
  return {
    platform: 'android' as const,
    channel: 'alpha',
    architecture: 'arm64-v8a' as const,
    packageName: 'id.my.anciety.codever',
    versionCode,
    versionName: `0.1.0-alpha.${versionCode}`,
    buildId: `android-alpha-${versionCode}`,
    publishedAt: 1_787_400_000_000 + versionCode,
    minimumAndroid: 31,
    nativeBridgeMinimum: 1,
    nativeBridgeMaximum: 1,
    importance: 'recommended' as const,
    releaseNotes: ['Gateway-published update'],
    artifact: {
      url: `https://rd.anciety.my.id/native-updates/releases/android/alpha/${versionCode}/codever.apk`,
      size: 1_024,
      sha256: 'a'.repeat(64),
      signingCertificateSha256: 'b'.repeat(64),
    },
  }
}
