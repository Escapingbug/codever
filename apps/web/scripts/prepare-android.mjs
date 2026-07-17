import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const gradleUrl = new URL('../src-tauri/gen/android/app/build.gradle.kts', import.meta.url)
const gradlePath = fileURLToPath(gradleUrl)
const activityUrl = new URL('../src-tauri/gen/android/app/src/main/java/dev/codever/client/MainActivity.kt', import.meta.url)
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

if (source.includes(disabled)) {
  await writeFile(gradleUrl, source.replace(disabled, enabled), 'utf8')
}

const statusBarItems = `        <item name="android:statusBarColor">#11130F</item>
        <item name="android:navigationBarColor">#11130F</item>
        <item name="android:windowLightStatusBar">false</item>
        <item name="android:windowLightNavigationBar">false</item>`
for (const themeUrl of themeUrls) {
  const themePath = fileURLToPath(themeUrl)
  const theme = await readFile(themeUrl, 'utf8')
  if (!theme.includes('android:windowLightStatusBar')) {
    const closingStyle = '    </style>'
    if (!theme.includes(closingStyle)) throw new Error(`Unable to find the Android theme in ${themePath}`)
    await writeFile(themeUrl, theme.replace(closingStyle, `${statusBarItems}\n${closingStyle}`), 'utf8')
  }
}

const activityPath = fileURLToPath(activityUrl)
let activity = await readFile(activityUrl, 'utf8')
if (!activity.includes('WindowCompat.getInsetsController')) {
  const importAnchor = 'import androidx.activity.enableEdgeToEdge'
  const superAnchor = '    super.onCreate(savedInstanceState)'
  if (!activity.includes(importAnchor) || !activity.includes(superAnchor)) {
    throw new Error(`Unable to configure Android system-bar contrast in ${activityPath}`)
  }
  activity = activity
    .replace(importAnchor, `${importAnchor}\nimport androidx.core.view.WindowCompat`)
    .replace(superAnchor, `${superAnchor}\n    WindowCompat.getInsetsController(window, window.decorView).apply {\n      isAppearanceLightStatusBars = false\n      isAppearanceLightNavigationBars = false\n    }`)
  await writeFile(activityUrl, activity, 'utf8')
}

process.stdout.write('Android native OPAQUE transport and dark system bars enabled for release builds.\n')
