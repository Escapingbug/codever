import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const [apkArgument] = process.argv.slice(2)
if (!apkArgument) throw new Error('Usage: node retained-upgrade.mjs <signed-apk>')
const apk = resolve(apkArgument)
const adb = process.env.ADB ?? 'adb'

await launch()
await waitForText('Connected', 45_000)
assertPrivateWorkspace('before upgrade')
const installedBefore = packageTimes()

run('install', '-r', apk)
await launch()
await waitForText('Connected', 45_000)
assertPrivateWorkspace('after upgrade')
const installedAfter = packageTimes()
if (installedBefore.firstInstallTime !== installedAfter.firstInstallTime) {
  throw new Error('The package was reinstalled as a new app instead of updated with retained data')
}

await tapAccessibleWhenReady(/Computers$/)
await waitForText('Windows Computer', 45_000)
await tapTextWhenReady('Windows Computer')
await waitForAccessible(/^Codever codex$/, 45_000)
const final = visibleText()
const failure = final.find(text => /secure matrix synchronization is not connected|reconnect codever|sign in again|verify this computer/i.test(text))
if (failure) throw new Error(`Retained upgrade requires recovery: ${failure}`)
process.stdout.write(`PASS Android retained-data upgrade kept Matrix sync, Gateway trust, and Projects (${installedBefore.firstInstallTime})\n`)

async function launch() {
  run('shell', 'am', 'force-stop', 'dev.codever.client')
  run('shell', 'am', 'start', '-W', '-n', 'dev.codever.client/.MainActivity')
  await waitForAnyText(['Projects', 'Connect to Codever', 'Sign in to Codever'], 30_000)
}

function assertPrivateWorkspace(stage) {
  const text = visibleText()
  const entry = text.find(value => value === 'Connect to Codever' || value === 'Sign in to Codever')
  if (entry) throw new Error(`Authentication was not retained ${stage}: ${entry}`)
}

function packageTimes() {
  const output = run('shell', 'dumpsys', 'package', 'dev.codever.client')
  const firstInstallTime = output.match(/firstInstallTime=([^\r\n]+)/)?.[1]?.trim()
  const lastUpdateTime = output.match(/lastUpdateTime=([^\r\n]+)/)?.[1]?.trim()
  if (!firstInstallTime || !lastUpdateTime) throw new Error('Android package timestamps are unavailable')
  return { firstInstallTime, lastUpdateTime }
}

async function tapAccessibleWhenReady(pattern, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const node = nodes(hierarchy()).find(value => value.clickable === 'true'
      && (pattern.test(value.text) || pattern.test(value['content-desc'] ?? '')))
    if (node) { tap(node.bounds); return }
    await delay(250)
  }
  throw new Error(`Accessible action ${pattern} did not become available`)
}

async function waitForAccessible(pattern, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const node = nodes(hierarchy()).find(value => pattern.test(value.text) || pattern.test(value['content-desc'] ?? ''))
    if (node) return node
    await delay(250)
  }
  throw new Error(`Accessible content ${pattern} did not become available`)
}

async function tapTextWhenReady(text, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const node = nodes(hierarchy()).find(value => value.text === text && visible(value.bounds))
    if (node) { tap(node.bounds); return }
    await delay(250)
  }
  throw new Error(`${text} did not become available`)
}

async function waitForText(text, timeout) { return waitForAnyText([text], timeout) }
async function waitForAnyText(expected, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const text = visibleText()
    const match = expected.find(value => text.includes(value))
    if (match) return match
    await delay(300)
  }
  throw new Error(`Timed out waiting for ${expected.join(' or ')}`)
}

function visibleText() { return nodes(hierarchy()).filter(node => visible(node.bounds)).map(node => node.text).filter(Boolean) }
function hierarchy() {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = spawnSync(adb, ['shell', 'uiautomator', 'dump', '/sdcard/codever-retained-upgrade.xml'], { encoding: 'utf8' })
    if (result.status === 0) return run('exec-out', 'cat', '/sdcard/codever-retained-upgrade.xml')
    if (attempt < 5) spawnSync(adb, ['shell', 'sleep', '0.5'], { stdio: 'ignore' })
    else throw new Error(`UI hierarchy unavailable after 5 attempts: ${(result.stderr ?? '').trim() || 'uiautomator returned no diagnostic'}`)
  }
  throw new Error('UI hierarchy unavailable')
}
function nodes(xml) {
  return [...xml.matchAll(/<node\s+([^>]+?)\s*\/?\s*>/g)].map(match =>
    Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(value => [value[1], decode(value[2])])),
  )
}
function decode(value) { return value.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>') }
function visible(bounds) { const values = bounds?.match(/\d+/g)?.map(Number); return Boolean(values?.length === 4 && values[2] > values[0] && values[3] > values[1]) }
function tap(bounds) { const values = bounds?.match(/\d+/g)?.map(Number); if (!values || values.length !== 4) throw new Error(`Invalid bounds ${bounds}`); run('shell', 'input', 'tap', String((values[0] + values[2]) >> 1), String((values[1] + values[3]) >> 1)) }
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)) }
function run(...args) { const result = spawnSync(adb, args, { encoding: 'utf8' }); if (result.status !== 0) throw new Error(`ADB ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`); return result.stdout }
