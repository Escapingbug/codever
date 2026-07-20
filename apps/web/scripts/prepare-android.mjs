import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const gradleUrl = new URL('../src-tauri/gen/android/app/build.gradle.kts', import.meta.url)
const gradlePath = fileURLToPath(gradleUrl)
const gradlePropertiesUrl = new URL('../src-tauri/gen/android/gradle.properties', import.meta.url)
const mainActivityTemplateUrl = new URL('./templates/MainActivity.kt', import.meta.url)
const mainActivityUrl = new URL('../src-tauri/gen/android/app/src/main/java/dev/codever/client/MainActivity.kt', import.meta.url)
const manifestUrl = new URL('../src-tauri/gen/android/app/src/main/AndroidManifest.xml', import.meta.url)
const androidXmlUrl = new URL('../src-tauri/gen/android/app/src/main/res/xml/', import.meta.url)
const themeUrls = [
  new URL('../src-tauri/gen/android/app/src/main/res/values/themes.xml', import.meta.url),
  new URL('../src-tauri/gen/android/app/src/main/res/values-night/themes.xml', import.meta.url),
]
const disabled = 'manifestPlaceholders["usesCleartextTraffic"] = "false"'
const enabled = 'manifestPlaceholders["usesCleartextTraffic"] = "true"'
const source = await readFile(gradleUrl, 'utf8')

if (!source.includes(disabled) && !source.includes(enabled)) {
  throw new Error(`Unable to find the Android cleartext manifest placeholder in ${gradlePath}`)
}

if (source.includes(enabled)) {
  await writeFile(gradleUrl, source.replace(enabled, disabled), 'utf8')
}

let gradleProperties = await readFile(gradlePropertiesUrl, 'utf8')
const stableKotlinSettings = [
  // Kotlin's relocatable incremental cache cannot relativize Tauri sources in
  // Cargo's C: registry against a generated Android project on D:.
  'kotlin.incremental=false',
  'kotlin.compiler.execution.strategy=in-process',
]
for (const setting of stableKotlinSettings) {
  if (!gradleProperties.includes(setting)) gradleProperties = `${gradleProperties.trimEnd()}\n${setting}\n`
}
await writeFile(gradlePropertiesUrl, gradleProperties, 'utf8')

await writeFile(mainActivityUrl, await readFile(mainActivityTemplateUrl, 'utf8'), 'utf8')

let manifest = await readFile(manifestUrl, 'utf8')
if (!manifest.includes('<application')) throw new Error('Unable to find the Android application manifest')
manifest = manifest
  .replace(/\s+android:allowBackup="[^"]*"/g, '')
  .replace(/\s+android:dataExtractionRules="[^"]*"/g, '')
  .replace(/\s+android:fullBackupContent="[^"]*"/g, '')
  .replace('<application', `<application
        android:allowBackup="false"
        android:dataExtractionRules="@xml/data_extraction_rules"
        android:fullBackupContent="@xml/backup_rules"`)
await writeFile(manifestUrl, manifest, 'utf8')

await mkdir(androidXmlUrl, { recursive: true })
await writeFile(new URL('backup_rules.xml', androidXmlUrl), `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
    <exclude domain="root" path="." />
    <exclude domain="file" path="." />
    <exclude domain="database" path="." />
    <exclude domain="sharedpref" path="." />
    <exclude domain="external" path="." />
</full-backup-content>
`, 'utf8')
await writeFile(new URL('data_extraction_rules.xml', androidXmlUrl), `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="root" path="." />
        <exclude domain="file" path="." />
        <exclude domain="database" path="." />
        <exclude domain="sharedpref" path="." />
        <exclude domain="external" path="." />
        <exclude domain="device_root" path="." />
        <exclude domain="device_file" path="." />
        <exclude domain="device_database" path="." />
        <exclude domain="device_sharedpref" path="." />
    </cloud-backup>
    <device-transfer>
        <exclude domain="root" path="." />
        <exclude domain="file" path="." />
        <exclude domain="database" path="." />
        <exclude domain="sharedpref" path="." />
        <exclude domain="external" path="." />
        <exclude domain="device_root" path="." />
        <exclude domain="device_file" path="." />
        <exclude domain="device_database" path="." />
        <exclude domain="device_sharedpref" path="." />
    </device-transfer>
</data-extraction-rules>
`, 'utf8')

const systemBarThemeItems = [
  '        <item name="android:statusBarColor">#11130F</item>',
  '        <item name="android:navigationBarColor">#11130F</item>',
  '        <item name="android:windowBackground">#11130F</item>',
  '        <item name="android:colorBackground">#11130F</item>',
  '        <item name="android:windowLightStatusBar">false</item>',
  '        <item name="android:windowLightNavigationBar">false</item>',
]
for (const themeUrl of themeUrls) {
  const themePath = fileURLToPath(themeUrl)
  let theme = await readFile(themeUrl, 'utf8')
  const closingStyle = '    </style>'
  if (!theme.includes(closingStyle)) throw new Error(`Unable to find the Android theme in ${themePath}`)
  const missingItems = systemBarThemeItems.filter(item => !theme.includes(item.trim()))
  if (missingItems.length > 0) theme = theme.replace(closingStyle, `${missingItems.join('\n')}\n${closingStyle}`)
  await writeFile(themeUrl, theme, 'utf8')
}

process.stdout.write('Android HTTPS-only Matrix transport, backup isolation, and dark system-bar theme enabled for release builds.\n')
