import { spawnSync } from 'node:child_process'

const adb = process.env.ADB ?? 'adb'
const gatewayName = process.env.CODEVER_E2E_GATEWAY ?? 'Windows Computer'
run('shell', 'am', 'force-stop', 'dev.codever.client')
run('shell', 'am', 'start', '-W', '-n', 'dev.codever.client/.MainActivity')
await waitForAppSurface(30_000)
const devtools = await connectDevtools()
stage('app started')
let title = visibleText(/^Android E2E /)

if (isSessionEditor() && !title) {
  await tapAccessibleWhenReady(/^Go back$/, 10_000)
  await waitForText('Tasks', 30_000)
}

if (!isSessionEditor()) {
  await tapAccessibleWhenReady(/Computers$/)
  await waitForText(gatewayName, 30_000)
  stage('computer discovered')
  tapNode(nodes(hierarchy()).find(node => node.text === gatewayName && visible(node.bounds)), gatewayName)

  const gatewayAction = await waitForAccessibleAction([/^Request authorization$/, /^Codever codex$/], 30_000)
  if (gatewayAction.text === 'Request authorization') {
    tapNode(gatewayAction, 'Authorize this client')
    await tapAccessibleWhenReady(/^Codever codex$/, 30_000)
  } else {
    tapNode(gatewayAction, 'Codever codex')
  }
  await waitForText('Tasks', 30_000)
  stage('project opened')
  await tapAccessibleWhenReady(/New task$/, 30_000)
  await waitForText('Start with a fresh provider session')
  title = `Android E2E ${Date.now()}`
  await fillFocusedField(nodes(hierarchy()).find(node => node.class === 'android.widget.EditText'), title, 'Task title')
  await tapAccessibleWhenReady(/^Create task$/, 30_000)
  await waitForSessionEditor(title, 90_000)
  stage('task created')
}

if (!title) throw new Error('The Android E2E Session title is unavailable')
const replyToken = `E2E_OK_${Date.now()}`
const message = `Reply exactly ${replyToken}`
await fillComposer(message)
await tapAccessibleWhenReady(/^Send message$/, 10_000)
await waitForOptimisticMessage(message, 5_000)
stage('message rendered optimistically')
await waitForText('querying', 30_000)
stage('agent querying')
await waitForAgentReply(replyToken, 180_000)
stage('agent reply rendered')
await waitForText('idle', 30_000)

await tapAccessibleWhenReady(/^Go back$/, 10_000)
await waitForText('Tasks', 30_000)
await clickTaskByName([title, message], 30_000)
await waitForSessionEditor([title, message], 60_000)
await waitForAgentReply(replyToken, 15_000)
stage('cached task reopened')
devtools.close()
process.stdout.write(`PASS Android Gateway authorization, Project, real Codex reply, and cached Session reopen (${replyToken})\n`)

async function tapAccessibleWhenReady(pattern, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = nodes(hierarchy()).find(node => node.clickable === 'true'
      && visible(node.bounds)
      && (pattern.test(node.text) || pattern.test(node['content-desc'] ?? '')))
    if (value) {
      tapNode(value, String(pattern))
      return
    }
    await delay(250)
  }
  throw new Error(`Accessible action ${pattern} did not become available`)
}

async function waitForAccessibleAction(patterns, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const action = nodes(hierarchy()).find(node => node.clickable === 'true'
      && visible(node.bounds)
      && patterns.some(pattern => pattern.test(node.text) || pattern.test(node['content-desc'] ?? '')))
    if (action) return action
    await delay(250)
  }
  throw new Error(`Accessible action ${patterns.join(' or ')} did not become available`)
}

async function waitForAccessibleName(names, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const action = nodes(hierarchy()).find(node => node.clickable === 'true'
      && visible(node.bounds)
      && names.includes(node['content-desc'] || node.text))
    if (action) return action
    await delay(250)
  }
  throw new Error(`Accessible action ${names.join(' or ')} did not become available`)
}

async function waitForAppSurface(timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const values = nodes(hierarchy()).filter(node => node.package === 'dev.codever.client')
    if (values.some(node => node.text || node['content-desc'])) return
    await delay(250)
  }
  throw new Error('Codever did not expose an Android UI surface within 30 seconds')
}

async function waitForText(text, timeout = 15_000) { return waitForAnyText([text], timeout) }
function visibleText(pattern) {
  return nodes(hierarchy()).find(node => visible(node.bounds) && pattern.test(node.text))?.text
}
function isSessionEditor() {
  return nodes(hierarchy()).some(node => visible(node.bounds)
    && (node.text === 'Upload files' || node['content-desc'] === 'Upload files'))
}
async function fillComposer(value) {
  const candidates = nodes(hierarchy()).filter(node => node.class === 'android.widget.EditText' && visible(node.bounds))
  const composer = candidates.at(-1)
  tapNode(composer, 'Message composer')
  await delay(300)
  const focused = nodes(hierarchy()).filter(node => node.class === 'android.widget.EditText' && visible(node.bounds)).at(-1)
  if (!focused || focused.focused !== 'true' || focused.bounds !== composer.bounds) {
    throw new Error('The message composer did not receive focus; refusing to type into another Session control')
  }
  run('shell', 'input', 'text', value.replaceAll(' ', '%s'))
  await delay(300)
  const updated = nodes(hierarchy()).find(node => node.class === 'android.widget.EditText'
    && node.focused === 'true' && node.text === value)
  if (!updated) throw new Error('The message composer did not receive the expected text')
}
async function waitForOptimisticMessage(message, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const values = nodes(hierarchy()).filter(node => visible(node.bounds))
    const bubble = values.some(node => {
      const accessibleName = node['content-desc'] || node.text
      return accessibleName === `Your message: ${message}`
        || (node.class !== 'android.widget.EditText' && node.text === message)
    })
    const cleared = values.filter(node => node.class === 'android.widget.EditText').at(-1)?.text === ''
    if (bubble && cleared) return
    await delay(150)
  }
  throw new Error('The sent message was not rendered optimistically within 5 seconds')
}
async function waitForAgentReply(token, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const values = nodes(hierarchy()).filter(node => visible(node.bounds))
    if (values.some(node => {
      const accessibleName = node['content-desc'] || node.text
      return accessibleName.startsWith('Agent response') && accessibleName.includes(token)
    }) || await renderedAgentReply(token)) return
    const error = values.find(node => /provider.*not ready|could not refresh|session unavailable|command is still pending/i.test(node.text))
    if (error) throw new Error(error.text)
    await delay(300)
  }
  throw new Error(`Codex reply ${token} did not arrive within ${Math.round(timeout / 1000)} seconds`)
}
async function renderedAgentReply(token) {
  return devtools.evaluate(`(() => {
    const token = ${JSON.stringify(token)}
    return [...document.querySelectorAll('.message--assistant')].some(element => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return element.getAttribute('aria-label')?.startsWith('Agent response')
        && element.textContent?.includes(token)
        && rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.top < innerHeight
        && style.display !== 'none' && style.visibility !== 'hidden'
    })
  })()`)
}

async function clickTaskByName(names, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const clicked = await devtools.evaluate(`(() => {
      const names = ${JSON.stringify(names.map(name => `Open task ${name}`))}
      const element = [...document.querySelectorAll('[role="button"][aria-label]')]
        .find(value => names.includes(value.getAttribute('aria-label')))
      if (!(element instanceof HTMLElement)) return false
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      element.click()
      return true
    })()`)
    if (clicked) return
    await delay(250)
  }
  throw new Error(`Task card ${names.join(' or ')} did not become available`)
}

async function connectDevtools() {
  const appProcessId = run('shell', 'pidof', 'dev.codever.client').trim()
  if (!/^\d+$/.test(appProcessId)) throw new Error(`Invalid Codever Android process ID: ${appProcessId}`)
  const port = Number(run('forward', 'tcp:0', `localabstract:webview_devtools_remote_${appProcessId}`).trim())
  if (!Number.isInteger(port) || port <= 0) throw new Error('ADB did not allocate a WebView DevTools port')
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = Array.isArray(pages) ? pages.find(value => value?.type === 'page' && value.webSocketDebuggerUrl) : undefined
  if (!page) throw new Error('Codever WebView DevTools page is unavailable')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('Could not connect to Codever WebView DevTools')), { once: true })
  })
  let requestId = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result?.result?.value)
  })
  return {
    evaluate(expression) {
      const id = ++requestId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
      })
    },
    close() { socket.close() },
  }
}
async function waitForSessionEditor(expectedTitles, timeout) {
  const titles = Array.isArray(expectedTitles) ? expectedTitles : [expectedTitles]
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const values = nodes(hierarchy()).filter(node => visible(node.bounds))
    const hasTitle = values.some(node => titles.includes(node.text))
    const hasComposer = values.some(node => node.text === 'Upload files' || node['content-desc'] === 'Upload files')
    const createModal = values.some(node => node.text === 'Start with a fresh provider session')
    if (hasTitle && hasComposer && !createModal) return
    const error = values.find(node => /could not create|timed out|failed/i.test(node.text))
    if (error) throw new Error(error.text)
    await delay(300)
  }
  throw new Error('Task creation did not reach the Session editor within 90 seconds')
}
function stage(value) { process.stdout.write(`[${new Date().toISOString()}] ${value}\n`) }
async function waitForAnyText(expected, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const values = nodes(hierarchy()).filter(node => visible(node.bounds)).map(node => node.text)
    const match = expected.find(text => values.includes(text))
    if (match) return match
    const error = values.find(text => /unable|failed|error/i.test(text))
    if (error) throw new Error(error)
    await delay(300)
  }
  throw new Error(`Timed out waiting for one of: ${expected.join(', ')}`)
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
function tapNode(node, label) {
  if (!node) throw new Error(`${label} is unavailable`)
  const values = node.bounds.match(/\d+/g)?.map(Number)
  if (!values || values.length !== 4) throw new Error(`Invalid Android bounds for ${label}: ${node.bounds}`)
  run('shell', 'input', 'tap', String(Math.round((values[0] + values[2]) / 2)), String(Math.round((values[1] + values[3]) / 2)))
}
async function fillFocusedField(node, value, label) {
  tapNode(node, label)
  run('shell', 'input', 'text', value.replaceAll(' ', '%s'))
  run('shell', 'input', 'keyevent', '4')
  await delay(500)
  const updated = nodes(hierarchy()).find(candidate => candidate.class === 'android.widget.EditText'
    && candidate.text === value)
  if (!updated) throw new Error(`${label} did not receive the expected text`)
}
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)) }
function run(...args) {
  const result = spawnSync(adb, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  if (result.error) throw new Error(`Could not start ADB at ${JSON.stringify(adb)}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`ADB command failed (${args.slice(0, 3).join(' ')}): ${(result.stderr ?? '').trim()}`)
  return result.stdout
}
