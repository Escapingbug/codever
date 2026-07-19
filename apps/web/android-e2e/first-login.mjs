import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const [passwordFile] = process.argv.slice(2)
if (!passwordFile) throw new Error('Usage: node first-login.mjs <password-file>')

const adb = process.env.ADB ?? 'adb'
const password = readFileSync(passwordFile, 'utf8').trim()
if (password.length < 16) throw new Error('The Android E2E password file is empty or invalid')

await waitForText('Connect to Codever')
await fillSafeField(0, 'rd.anciety.my.id')
await tapText('Continue')
await waitForText('Sign in to Codever')
await fillSafeField(0, 'codever')

const login = hierarchy()
const passwordField = fields(login, 'android.widget.EditText').find(node => node.password === 'true')
const signIn = nodes(login).find(node => node.text === 'Sign in' && node.class === 'android.widget.Button')
if (!passwordField || !signIn) throw new Error('Login controls are not available')

tap(passwordField.bounds)
inputText(password)
key('4')
await delay(750)
tap(signIn.bounds)

const page = await waitForResult(30_000)
if (page !== 'Computers') throw new Error(page)
process.stdout.write('PASS Android fresh install and real Matrix login\n')

async function fillSafeField(index, value) {
  let document = hierarchy()
  let field = fields(document, 'android.widget.EditText')[index]
  if (!field) throw new Error(`Text field ${index} is not available`)
  tap(field.bounds)
  inputText(value)
  key('4')
  document = hierarchy()
  field = fields(document, 'android.widget.EditText')[index]
  if (field?.text !== value) throw new Error(`ADB entered an unexpected value in safe text field ${index}`)
}

async function tapText(text) {
  const node = nodes(hierarchy()).find(value => value.text === text)
  if (!node) throw new Error(`Could not find ${JSON.stringify(text)}`)
  tap(node.bounds)
}

async function waitForText(text, timeout = 15_000) {
  return waitForAnyText([text], timeout)
}

async function waitForAnyText(expected, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const visible = new Set(nodes(hierarchy()).filter(node => node.password !== 'true').map(node => node.text))
    const match = expected.find(text => visible.has(text))
    if (match) return match
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out waiting for one of: ${expected.join(', ')}`)
}

async function waitForResult(timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const visible = nodes(hierarchy()).filter(node => node.password !== 'true' && node.class !== 'android.widget.EditText').map(node => node.text)
    if (visible.includes('Computers')) return 'Computers'
    const error = visible.find(text => /unable|failed|error|invalid/i.test(text))
    if (error) return error
    await delay(500)
  }
  return 'Login did not leave the credential form within 30 seconds'
}

function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)) }

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
  return [...xml.matchAll(/<node\s+([^>]+?)\s*\/?\s*>/g)].map(match => {
    const attributes = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(value => [value[1], decode(value[2])]))
    return attributes
  })
}

function fields(xml, className) { return nodes(xml).filter(node => node.class === className) }
function decode(value) { return value.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>') }
function tap(bounds) {
  const values = bounds?.match(/\d+/g)?.map(Number)
  if (!values || values.length !== 4) throw new Error(`Invalid Android bounds: ${bounds}`)
  run('shell', 'input', 'tap', String(Math.round((values[0] + values[2]) / 2)), String(Math.round((values[1] + values[3]) / 2)))
}
function inputText(value) { run('shell', 'input', 'text', value) }
function key(code) { run('shell', 'input', 'keyevent', code) }
function run(...args) {
  const result = spawnSync(adb, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  if (result.error) throw new Error(`Could not start ADB at ${JSON.stringify(adb)}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`ADB command failed (${args.slice(0, 3).join(' ')}): ${(result.stderr ?? '').trim()}`)
  return result.stdout
}
