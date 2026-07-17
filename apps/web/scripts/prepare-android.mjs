import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const gradleUrl = new URL('../src-tauri/gen/android/app/build.gradle.kts', import.meta.url)
const gradlePath = fileURLToPath(gradleUrl)
const disabled = 'manifestPlaceholders["usesCleartextTraffic"] = "false"'
const enabled = 'manifestPlaceholders["usesCleartextTraffic"] = "true"'
const source = await readFile(gradleUrl, 'utf8')

if (!source.includes(disabled) && !source.includes(enabled)) {
  throw new Error(`Unable to find the Android cleartext manifest placeholder in ${gradlePath}`)
}

if (source.includes(disabled)) {
  await writeFile(gradleUrl, source.replace(disabled, enabled), 'utf8')
}

process.stdout.write('Android native OPAQUE transport enabled for release builds.\n')
