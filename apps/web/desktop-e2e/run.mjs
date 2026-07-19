import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { remote } from 'webdriverio'

const port = 4445
const appBinaryPath = resolve('src-tauri/target/debug/codever-app.exe')
const credentialAccount = 'desktop-e2e-credential'
let app
let browser
let appOutput = ''

try {
  await startApp()
  await resetBusinessCache()
  await restartApp()
  await test('native WebView2 window and desktop layout', async () => {
    assert.equal(await browser.getTitle(), 'Codever')
    assert.equal(await browser.execute(() => window.location.hostname), 'tauri.localhost')
    assert.equal(await browser.execute(() => '__TAURI_INTERNALS__' in window), true)

    await browser.setWindowSize(1000, 700)
    const layout = await browser.execute(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
    }))
    assert.ok(layout.documentWidth <= layout.viewportWidth)
    assert.ok(layout.documentHeight >= layout.viewportHeight)
  })

  await test('late native listener errors do not replace the running application', async () => {
    await browser.execute(() => window.__CODEVER_E2E__.reportRuntimeError())
    assert.equal(await browser.$('h1').getText(), 'Build Android client')
    assert.equal((await browser.$('body').getText()).includes('Codever could not start.'), false)
    assert.equal(await browser.$('.composer textarea').isEnabled(), true)
  })

  await test('WebView cache state survives a native process restart', async () => {
    const marker = `restart-${Date.now()}`
    await browser.executeAsync((value, done) => {
      localStorage.setItem('codever.desktop-e2e.restart', value)
      const request = indexedDB.open('codever-desktop-e2e', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('markers')
      request.onerror = () => done({ error: request.error?.message ?? 'open failed' })
      request.onsuccess = () => {
        const transaction = request.result.transaction('markers', 'readwrite')
        transaction.objectStore('markers').put(value, 'restart')
        transaction.oncomplete = () => { request.result.close(); done(null) }
        transaction.onerror = () => done({ error: transaction.error?.message ?? 'write failed' })
      }
    }, marker)

    await restartApp()

    const restored = await browser.executeAsync(done => {
      const local = localStorage.getItem('codever.desktop-e2e.restart')
      const request = indexedDB.open('codever-desktop-e2e', 1)
      request.onerror = () => done({ error: request.error?.message ?? 'open failed' })
      request.onsuccess = () => {
        const read = request.result.transaction('markers').objectStore('markers').get('restart')
        read.onsuccess = () => { request.result.close(); done({ local, indexed: read.result }) }
        read.onerror = () => done({ error: read.error?.message ?? 'read failed' })
      }
    })
    assert.deepEqual(restored, { local: marker, indexed: marker })
  })

  await test('Windows Credential Manager persistence across process restart', async () => {
    const value = `native-secret-${Date.now()}`
    await setNativeSecret(value)
    assert.equal(await getNativeSecret(), value)

    await restartApp()
    assert.equal(await getNativeSecret(), value)

    await deleteNativeSecret()
    assert.equal(await getNativeSecret(), null)
  })

  await test('optimistic message reconciliation and Provider output', async () => {
    const message = `Run the Windows desktop journey ${Date.now()}`
    const composer = await browser.$('.composer textarea')
    await composer.setValue(message)
    await browser.$('button.send-button').click()

    assert.equal(await composer.getValue(), '')
    const pending = await browser.$('.message--pending')
    await pending.waitForDisplayed()
    assert.ok((await texts('.message--pending')).some(text => text.includes(message)))

    await browser.execute(() => window.__CODEVER_E2E__.completeTurn())
    try {
      await browser.waitUntil(async () => {
        const pendingMessages = await texts('.message--pending')
        return !pendingMessages.some(text => text.includes(message))
      }, { timeout: 10_000, timeoutMsg: 'The optimistic message was not reconciled' })
    } catch (error) {
      const diagnostic = await browser.execute(() => ({
        pending: Array.from(document.querySelectorAll('.message--pending'), element => element.textContent),
        users: Array.from(document.querySelectorAll('.message--user'), element => element.textContent),
        assistants: Array.from(document.querySelectorAll('.message--assistant'), element => element.textContent),
        lastSent: window.__CODEVER_E2E__.lastSentInput(),
      }))
      throw new Error(`The optimistic message was not reconciled: ${JSON.stringify(diagnostic)}`, { cause: error })
    }
    await browser.waitUntil(async () => {
      const responses = await texts('.message--assistant')
      return responses.some(text => text.includes('First reply.'))
    }, { timeout: 10_000, timeoutMsg: 'The authoritative Provider reply was not rendered' })
    const userMessages = await texts('.message--user')
    assert.equal(userMessages
      .filter(text => text.includes(message)).length, 1)
  })

  await test('cached conversation and input recovery after connectivity loss', async () => {
    await browser.execute(() => window.__CODEVER_E2E__.setConnection('disconnected'))
    const cached = await browser.$('.message--assistant')
    assert.match(await cached.getText(), /Build ready|First reply/)
    assert.match(await browser.$('.connection-banner').getText(), /Server offline/)
    assert.equal(await browser.$('.composer textarea').isEnabled(), false)

    await browser.execute(() => window.__CODEVER_E2E__.setConnection('connected'))
    await browser.$('.connection-banner').waitForExist({ reverse: true })
    assert.equal(await browser.$('.composer textarea').isEnabled(), true)
  })

  await test('Stop cancels native in-flight work and restores the composer', async () => {
    const composer = await browser.$('.composer textarea')
    await composer.setValue('Run a long Windows verification')
    await browser.$('button.send-button').click()
    await browser.execute(() => window.__CODEVER_E2E__.startLongTurn())

    const stop = await elementByText('button', 'Stop')
    await stop.waitForDisplayed()
    await stop.click()
    await browser.waitUntil(async () => !(await texts('button')).includes('Stop'))
    assert.equal(await composer.isEnabled(), true)
    assert.ok((await texts('.session-header')).some(text => text.includes('idle')))
  })

  await test('Decision resolves without opening the event inspector', async () => {
    await browser.execute(() => window.__CODEVER_E2E__.requestDecision())
    await browser.waitUntil(async () => (await texts('.decision-card')).some(text => text.includes('Install the APK?')))
    const install = await elementByText('button', 'Install')
    await install.click()

    await browser.waitUntil(async () => (await texts('.decision-resolved')).some(text => text.includes('Resolved')))
    assert.equal(await browser.$('.inspector').getAttribute('class').then(value => value.includes('inspector--open')), false)
  })

  await test('model, reasoning, mode, and permissions are controlled through native UI', async () => {
    await chooseOption('.session-control--model select', 'scripted-model')
    await waitForConfig(value => value?.model === 'scripted-model', 'model')
    await chooseOption('.session-control--reasoning select', 'high')
    await waitForConfig(value => value?.config.reasoningEffort === 'high', 'reasoning effort')
    await chooseOption('.session-control--mode select', 'plan')
    await waitForConfig(value => value?.mode === 'plan', 'mode')
    await chooseOption('.session-control--permissions select', 'bypassPermissions')
    await waitForConfig(value => value?.config.permissionMode === 'bypassPermissions', 'permission mode')
  })
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  if (appOutput) process.stderr.write(`\nNative application output:\n${appOutput.slice(-8_000)}\n`)
  process.exitCode = 1
} finally {
  await deleteNativeSecret().catch(() => undefined)
  await stopApp()
}

async function test(name, operation) {
  const startedAt = Date.now()
  await operation()
  process.stdout.write(`PASS ${name} (${Date.now() - startedAt}ms)\n`)
}

async function startApp() {
  appOutput = ''
  app = spawn(appBinaryPath, [], {
    env: { ...process.env, TAURI_WEBDRIVER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  app.stdout.on('data', chunk => { appOutput += chunk.toString() })
  app.stderr.on('data', chunk => { appOutput += chunk.toString() })
  await waitForServer()
  browser = await remote({ hostname: '127.0.0.1', port, logLevel: 'error', capabilities: {} })
  await browser.$('h1').waitForDisplayed({ timeout: 15_000 })
  await browser.waitUntil(async () => {
    const tasks = await browser.$$('.session-row')
    return (await browser.$('h1').getText()) === 'Codever'
      && await firstMatching(tasks, async element => (await element.getText()).includes('Build Android client')) !== undefined
  }, { timeout: 15_000, timeoutMsg: 'The native Project page did not finish loading cached tasks' })
  const tasks = await browser.$$('.session-row')
  const task = await firstMatching(tasks, async element => (await element.getText()).includes('Build Android client'))
  await task.click()
  await browser.waitUntil(async () => await browser.$('h1').getText() === 'Build Android client', {
    timeout: 15_000, timeoutMsg: 'The native task click did not open its Session',
  })
  assert.equal(await browser.$('h1').getText(), 'Build Android client')
}

async function restartApp() {
  await stopApp()
  await startApp()
}

async function resetBusinessCache() {
  const result = await browser.executeAsync(done => {
    const request = indexedDB.open('codever-client-cache', 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('snapshots')) request.result.createObjectStore('snapshots')
    }
    request.onerror = () => done({ error: request.error?.message ?? 'open failed' })
    request.onsuccess = () => {
      const transaction = request.result.transaction('snapshots', 'readwrite')
      transaction.objectStore('snapshots').clear()
      transaction.oncomplete = () => { request.result.close(); done(null) }
      transaction.onerror = () => done({ error: transaction.error?.message ?? 'clear failed' })
    }
  })
  if (result && typeof result === 'object' && 'error' in result) {
    throw new Error(`Could not isolate the desktop E2E cache: ${result.error}`)
  }
}

async function stopApp() {
  if (browser) {
    await browser.deleteSession().catch(() => undefined)
    browser = undefined
  }
  if (!app) return
  const processHandle = app
  app = undefined
  if (processHandle.exitCode === null) processHandle.kill()
  await Promise.race([
    new Promise(resolveExit => processHandle.once('exit', resolveExit)),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 5_000)),
  ])
}

async function waitForServer() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (app?.exitCode !== null) throw new Error(`Codever exited before WebDriver started (${app?.exitCode})`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`)
      if (response.ok) return
    } catch {}
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  throw new Error('Embedded Tauri WebDriver did not become ready')
}

async function firstMatching(values, predicate) {
  for (const value of values) if (await predicate(value)) return value
  return undefined
}

function texts(selector) {
  return browser.execute(value => Array.from(document.querySelectorAll(value), element => element.textContent ?? ''), selector)
}

async function elementByText(selector, expected) {
  const elements = await browser.$$(selector)
  const element = await firstMatching(elements, async value => (await value.getText()).trim() === expected)
  if (!element) throw new Error(`Could not find ${selector} with text ${JSON.stringify(expected)}`)
  return element
}

async function waitForConfig(predicate, label) {
  await browser.waitUntil(async () => predicate(await browser.execute(() => window.__CODEVER_E2E__.lastConfig())), {
    timeout: 10_000,
    timeoutMsg: `The native ${label} selection was not persisted`,
  })
}

async function chooseOption(selector, selectedValue) {
  const changed = await browser.execute((query, value) => {
    const element = document.querySelector(query)
    if (!(element instanceof HTMLSelectElement)) return false
    element.value = value
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return element.value === value
  }, selector, selectedValue)
  assert.equal(changed, true)
}

function getNativeSecret() {
  return browser.executeAsync((account, done) => {
    window.__CODEVER_E2E__.nativeSecretGet(account).then(value => done(value ?? null), error => done({ error: String(error) }))
  }, credentialAccount)
}

async function setNativeSecret(value) {
  const result = await browser.executeAsync((account, secret, done) => {
    window.__CODEVER_E2E__.nativeSecretSet(account, secret).then(() => done(null), error => done({ error: String(error) }))
  }, credentialAccount, value)
  if (result && typeof result === 'object' && 'error' in result) throw new Error(result.error)
}

async function deleteNativeSecret() {
  if (!browser) return
  const result = await browser.executeAsync((account, done) => {
    window.__CODEVER_E2E__.nativeSecretDelete(account).then(() => done(null), error => done({ error: String(error) }))
  }, credentialAccount)
  if (result && typeof result === 'object' && 'error' in result) throw new Error(result.error)
}
