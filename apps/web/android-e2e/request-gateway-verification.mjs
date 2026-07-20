import { spawnSync } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [gatewayName = 'Windows Computer'] = process.argv.slice(2)
const adb = process.env.ADB ?? 'adb'
const verificationDirectory = process.env.GATEWAY_VERIFICATION_DIRECTORY
if (!verificationDirectory) throw new Error('GATEWAY_VERIFICATION_DIRECTORY is required for bilateral live verification')

await tapAccessibleWhenReady(/Computers$/)
await waitForText('Connected', 30_000)
await tapTextWhenReady(gatewayName, 30_000)
await waitForText('Verify this computer', 30_000)
await tapAccessibleWhenReady(/^Start secure verification$/)

for (let attempt = 0; attempt < 4; attempt += 1) {
  const action = await waitForAnyAccessible([/^They match$/, /^Continue$/], 30_000)
  if (action.text === 'They match') break
  tap(action.bounds)
}
await waitForText('They match', 30_000)

const before = nodes(hierarchy())
const marker = before.findIndex(node => node.text === 'Verification emoji' || node['content-desc'] === 'Verification emoji')
const descriptions = marker < 0 ? [] : before.slice(marker + 1)
  .filter(node => node.text && visible(node.bounds))
  .slice(0, 7)
  .map(node => node.text)
if (descriptions.length !== 7) throw new Error('Android did not expose all seven verification emoji descriptions')
const flow = await waitForGatewayFlow(verificationDirectory, descriptions)

await tapAccessibleWhenReady(/^They match$/)
await waitForText('Waiting for confirmation on the computer', 15_000)
writeDecision(verificationDirectory, flow.flowId)
await waitForGatewayDone(verificationDirectory, flow.flowId)
await waitForText('Authorize this client', 30_000)
await tapAccessibleWhenReady(/^Request authorization$/)
await waitForAnyText(['Projects', 'No projects on this computer'], 30_000)

const finalText = nodes(hierarchy()).map(node => node.text)
const failure = finalText.find(text => /secure matrix synchronization is not connected|gateway response timed out|connection unavailable/i.test(text))
if (failure) throw new Error(failure)
process.stdout.write(`${JSON.stringify({ stage: 'done', flowId: flow.flowId, descriptions })}\n`)

async function waitForGatewayFlow(directory, descriptions) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const status = JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'))
    const flow = [...status.flows].reverse().find(value => value.stage === 'present_sas'
      && JSON.stringify(value.emojis?.map(emoji => emoji.description)) === JSON.stringify(descriptions))
    if (flow) return flow
    await delay(250)
  }
  throw new Error('Gateway did not present the same seven verification emoji')
}
function writeDecision(directory, flowId) {
  const target = join(directory, `${encodeURIComponent(flowId)}.decision.json`)
  const temporary = `${target}.android-live.tmp`
  writeFileSync(temporary, `${JSON.stringify({ version: 1, flowId, matches: true })}\n`, { mode: 0o600 })
  renameSync(temporary, target)
}
async function waitForGatewayDone(directory, flowId) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const status = JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'))
    const flow = status.flows.find(value => value.flowId === flowId)
    if (flow?.stage === 'done') return
    if (flow?.stage === 'cancelled') throw new Error(flow.cancellation?.reason ?? 'Gateway verification was cancelled')
    await delay(250)
  }
  throw new Error('Gateway verification did not complete')
}
async function tapAccessibleWhenReady(pattern, timeout = 15_000) {
  const node = await waitForAnyAccessible([pattern], timeout)
  tap(node.bounds)
}
async function waitForAnyAccessible(patterns, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const node = nodes(hierarchy()).find(value => value.clickable === 'true' && visible(value.bounds)
      && patterns.some(pattern => pattern.test(value.text) || pattern.test(value['content-desc'] ?? '')))
    if (node) return node
    await delay(250)
  }
  throw new Error(`Accessible action ${patterns.join(' or ')} did not become available`)
}
async function tapTextWhenReady(text, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const node = nodes(hierarchy()).find(value => value.text === text && visible(value.bounds))
    if (node) { tap(node.bounds); return }
    await delay(250)
  }
  throw new Error(`${text} did not become available`)
}
async function waitForText(text, timeout = 15_000) { return waitForAnyText([text], timeout) }
async function waitForAnyText(expected, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const values = nodes(hierarchy()).filter(node => visible(node.bounds)).map(node => node.text)
    const match = expected.find(text => values.includes(text))
    if (match) return match
    const error = values.find(text => /unable|failed|error|not connected/i.test(text))
    if (error) throw new Error(error)
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${expected.join(' or ')}`)
}
function hierarchy() {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = spawnSync(adb, ['shell', 'uiautomator', 'dump', '/sdcard/codever-live-window.xml'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
    if (result.status === 0) return run('exec-out', 'cat', '/sdcard/codever-live-window.xml')
    if (attempt < 5) spawnSync(adb, ['shell', 'sleep', '0.5'], { stdio: 'ignore' })
    else throw new Error(`UI hierarchy unavailable: ${(result.stderr ?? '').trim()}`)
  }
  throw new Error('UI hierarchy unavailable')
}
function nodes(xml) {
  return [...xml.matchAll(/<node\s+([^>]+?)\s*\/?\s*>/g)].map(match =>
    Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(value => [value[1], decode(value[2])])),
  )
}
function decode(value) { return value.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>') }
function visible(bounds) { const value = bounds?.match(/\d+/g)?.map(Number); return Boolean(value?.length === 4 && value[2] > value[0] && value[3] > value[1]) }
function tap(bounds) { const value = bounds?.match(/\d+/g)?.map(Number); if (!value || value.length !== 4) throw new Error(`Invalid bounds ${bounds}`); run('shell', 'input', 'tap', String((value[0] + value[2]) >> 1), String((value[1] + value[3]) >> 1)) }
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)) }
function run(...args) { const result = spawnSync(adb, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }); if (result.status !== 0) throw new Error(`ADB ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`); return result.stdout }
