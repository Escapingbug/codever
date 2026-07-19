import { spawnSync } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [gatewayName = 'Windows Computer'] = process.argv.slice(2)
const adb = process.env.ADB ?? 'adb'

await tapAccessibleWhenReady(/Settings$/)
await waitForText('Devices')

let document
let gateway
for (let attempt = 0; attempt < 40; attempt += 1) {
  document = hierarchy()
  gateway = nodes(document).find(node => node.text === gatewayName && visible(node.bounds))
  if (gateway) break
  // Accounts used for long-running E2E can contain many historical devices.
  // Advance several focus targets between expensive UIAutomator snapshots so
  // the real Gateway remains reachable within the test's release-gate timeout.
  for (let step = 0; step < 3; step += 1) key('61')
  await delay(100)
}
if (!gateway || !document) throw new Error(`${gatewayName} could not be scrolled into view`)
const list = nodes(document)
const gatewayIndex = list.findIndex(node => node.text === gatewayName && node.bounds === gateway.bounds)
const verify = list.slice(gatewayIndex).find(node => node.text === 'Verify' && visible(node.bounds))
if (!verify) throw new Error(`Verify action for ${gatewayName} is unavailable`)
tap(verify.bounds)

let advances = 0
for (let attempt = 0; attempt < 50; attempt += 1) {
  await delay(400)
  document = hierarchy()
  const values = nodes(document)
  const error = values.find(node => /unable|failed|error/i.test(node.text))
  if (error) throw new Error(error.text)
  const match = values.find(node => node.text === 'They match' && visible(node.bounds))
  if (match) {
    const marker = values.findIndex(node => node.text === 'Verification emoji')
    const gatewayDeviceId = values.slice(0, marker).reverse().find(node => /^[A-Z]{10}$/.test(node.text))?.text
    const descriptions = marker < 0 ? [] : values.slice(marker + 1)
      .filter(node => node.text && visible(node.bounds))
      .slice(0, 7)
      .map(node => node.text)
    if (descriptions.length !== 7) throw new Error('Android verification emoji were not exposed to accessibility')
    if (!gatewayDeviceId) throw new Error('Gateway Matrix device id was not exposed to accessibility')
    const verificationDirectory = process.env.GATEWAY_VERIFICATION_DIRECTORY
    if (verificationDirectory) {
      const flow = await matchingGatewayFlow(verificationDirectory, descriptions)
      writeDecision(verificationDirectory, flow.flowId)
      tap(match.bounds)
      await waitForGatewayDone(verificationDirectory, flow.flowId)
      await waitForVerifiedDevice(gatewayDeviceId)
      process.stdout.write(`${JSON.stringify({ stage: 'done', descriptions })}\n`)
      process.exit(0)
    }
    process.stdout.write(`${JSON.stringify({ stage: 'present_sas', descriptions })}\n`)
    process.exit(0)
  }
  const next = values.find(node => node.text === 'Continue verification' && visible(node.bounds))
  if (next && advances < 3) {
    tap(next.bounds)
    advances += 1
    await delay(1_500)
    continue
  }
  // Verification cards can be below a long device list. Keyboard focus both
  // scrolls the WebView and keeps this test independent of screen dimensions.
  key('61')
}
throw new Error('Android verification did not reach emoji comparison')

async function matchingGatewayFlow(directory, descriptions) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const status = JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'))
    const flow = status.flows.find(value => value.stage === 'present_sas'
      && JSON.stringify(value.emojis?.map(emoji => emoji.description)) === JSON.stringify(descriptions))
    if (flow) return flow
    await delay(200)
  }
  throw new Error('Gateway did not present the same verification emoji')
}
function writeDecision(directory, flowId) {
  const target = join(directory, `${encodeURIComponent(flowId)}.decision.json`)
  const temporary = `${target}.android-e2e.tmp`
  writeFileSync(temporary, `${JSON.stringify({ version: 1, flowId, matches: true })}\n`, { mode: 0o600 })
  renameSync(temporary, target)
}
async function waitForGatewayDone(directory, flowId) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const status = JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'))
    const flow = status.flows.find(value => value.flowId === flowId)
    if (flow?.stage === 'done') return
    if (flow?.stage === 'cancelled') throw new Error(flow.cancellation?.reason ?? 'Gateway verification was cancelled')
    await delay(200)
  }
  throw new Error('Gateway verification did not complete')
}
async function waitForVerifiedDevice(deviceId) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const values = nodes(hierarchy())
    if (values.some(node => node.text === `${deviceId} · Verified`)) return
    const error = values.find(node => /unable|failed|error/i.test(node.text))
    if (error) throw new Error(error.text)
    await delay(200)
  }
  throw new Error('Android did not mark the Gateway device as verified')
}

async function tapAccessible(pattern) {
  const value = nodes(hierarchy()).find(node => node.clickable === 'true'
    && (pattern.test(node.text) || pattern.test(node['content-desc'] ?? '')))
  if (!value) throw new Error(`Accessible action ${pattern} is unavailable`)
  tap(value.bounds)
}
async function tapAccessibleWhenReady(pattern, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = nodes(hierarchy()).find(node => node.clickable === 'true'
      && (pattern.test(node.text) || pattern.test(node['content-desc'] ?? '')))
    if (value) {
      tap(value.bounds)
      return
    }
    await delay(250)
  }
  throw new Error(`Accessible action ${pattern} did not become available`)
}
async function waitForText(text, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (nodes(hierarchy()).some(node => node.text === text)) return
    await delay(300)
  }
  throw new Error(`Timed out waiting for ${text}`)
}
function hierarchy() {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = spawnSync(adb, ['shell', 'uiautomator', 'dump', '/sdcard/codever-e2e-window.xml'], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    })
    if (result.status === 0) return run('exec-out', 'cat', '/sdcard/codever-e2e-window.xml')
    if (attempt < 5) spawnSync(adb, ['shell', 'sleep', '0.5'], { stdio: 'ignore' })
    else throw new Error(`UI hierarchy unavailable after 5 attempts: ${result.error?.message ?? ((result.stderr ?? '').trim() || 'uiautomator returned no diagnostic')}`)
  }
  throw new Error('UI hierarchy unavailable')
}
function nodes(xml) {
  return [...xml.matchAll(/<node\s+([^>]+?)\s*\/?\s*>/g)].map(match =>
    Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(value => [value[1], decode(value[2])])),
  )
}
function decode(value) { return value.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>') }
function visible(bounds) {
  const values = bounds?.match(/\d+/g)?.map(Number)
  return Boolean(values && values.length === 4 && values[2] > values[0] && values[3] > values[1])
}
function tap(bounds) {
  const values = bounds?.match(/\d+/g)?.map(Number)
  if (!values || values.length !== 4) throw new Error(`Invalid Android bounds: ${bounds}`)
  run('shell', 'input', 'tap', String(Math.round((values[0] + values[2]) / 2)), String(Math.round((values[1] + values[3]) / 2)))
}
function key(code) { run('shell', 'input', 'keyevent', code) }
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)) }
function run(...args) {
  const result = spawnSync(adb, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  if (result.error) throw new Error(`Could not start ADB at ${JSON.stringify(adb)}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`ADB command failed (${args.slice(0, 3).join(' ')}): ${(result.stderr ?? '').trim()}`)
  return result.stdout
}
