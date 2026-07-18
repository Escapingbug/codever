import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import WebSocket from 'ws'
import type { SessionEventEnvelope } from '@codever/protocol'
import { RelayApi } from '../apps/web/src/api/relayApi'
import { MemorySecretStore } from '../apps/web/src/security/secretStore'

Object.assign(globalThis, { WebSocket })

const input = argumentsFrom(process.argv.slice(2))
const gatewayId = required(input.gateway, '--gateway')
const relayCode = required(input['relay-code'], '--relay-code')
const gatewayCode = required(input['gateway-code'], '--gateway-code')
const root = resolve(input.root ?? 'D:/codever-e2e-workspace')
const secrets = new MemorySecretStore()
const profileId = `real-e2e-${Date.now()}`
const api = createApi(secrets, profileId)
const clients = new Set<RelayApi>([api])

try {
  await mkdir(root, { recursive: true })
  milestone('pair-relay')
  await api.pairRelay(relayCode, `client_e2e_${crypto.randomUUID()}`)
await waitFor(async () => (await api.listGateways()).some(value => value.id === gatewayId), 30_000)
milestone('pair-gateway')
await api.pairGateway(gatewayId, gatewayCode)

const existing = (await api.listProjects(gatewayId)).find(project =>
  project.rootPath.toLowerCase() === root.toLowerCase()
  || project.canonicalRoot.toLowerCase() === root.toLowerCase())
const project = existing ?? await api.createProject(gatewayId, {
  name: `Codever real E2E ${new Date().toISOString()}`,
  rootPath: root,
  defaultProvider: 'codex',
})
api.rememberRoute(gatewayId, project.id)
const session = await api.createSession(project.id, {
  provider: 'codex',
  title: 'Real development lifecycle E2E',
  config: { permissionMode: 'bypassPermissions', reasoningEffort: 'low' },
})
api.rememberRoute(gatewayId, project.id, session.id)

const observed: SessionEventEnvelope[] = []
const unsubscribe = api.subscribeSession(session.id, event => observed.push(event))

milestone('develop')
await api.sendMessage(session.id, {
  text: 'Create answer.txt in this project with exactly one line: first implementation. Do not modify any other file.',
  clientMessageId: crypto.randomUUID(),
})
await waitForTurn(observed, 'success', 240_000)
expectText(await readFile(resolve(root, 'answer.txt'), 'utf8'), 'first implementation')

milestone('interrupt')
const beforeInterrupt = lastSeq(observed)
await api.sendMessage(session.id, {
  text: 'Run this exact command and wait for it to finish: node -e "setTimeout(() => {}, 60000)"',
  clientMessageId: crypto.randomUUID(),
})
await waitFor(() => observed.some(event => event.seq > beforeInterrupt && event.event.kind === 'tool'), 240_000)
const cancelStarted = Date.now()
await api.cancelSession(session.id, { reason: 'real E2E interruption' })
if (Date.now() - cancelStarted > 5_000) throw new Error('Stop acknowledgement exceeded five seconds')
await waitForTurn(observed, 'cancelled', 15_000, beforeInterrupt)

milestone('disconnect-and-adjust')
const beforeAdjustment = lastSeq(observed)
await api.sendMessage(session.id, {
  text: 'Replace answer.txt so it contains exactly two lines: first implementation, then adjusted requirement. Do not modify any other file.',
  clientMessageId: crypto.randomUUID(),
})
unsubscribe()
await api.disconnect()

const resumed = createApi(secrets, profileId)
clients.add(resumed)
await resumed.restoreRelay()
resumed.rememberRoute(gatewayId, project.id, session.id)
const resumedEvents: SessionEventEnvelope[] = []
const unsubscribeResumed = resumed.subscribeSession(session.id, event => resumedEvents.push(event))
await waitForTurn(resumedEvents, 'success', 240_000, beforeAdjustment)
expectText(await readFile(resolve(root, 'answer.txt'), 'utf8'), 'first implementation\nadjusted requirement')

const history = await resumed.getSessionEvents(session.id, { limit: 20 })
if (!history.events.some(event => event.event.kind === 'turn_finished')) {
  throw new Error('Authoritative history did not contain a completed turn')
}
unsubscribeResumed()
await resumed.disconnect()
milestone('complete', { sessionId: session.id, projectId: project.id, root })
} finally {
  await Promise.allSettled([...clients].map(client => client.disconnect()))
}

function createApi(secrets: MemorySecretStore, relayProfileId: string): RelayApi {
  return new RelayApi({
    baseUrl: 'https://rd.anciety.my.id:8787',
    relayProfileId,
    secrets,
    requestTimeoutMs: 10_000,
  })
}

async function waitForTurn(
  events: SessionEventEnvelope[],
  status: 'success' | 'cancelled',
  timeoutMs: number,
  after = 0,
): Promise<void> {
  await waitFor(() => events.some(value => value.seq > after && value.event.kind === 'turn_finished'
    && value.event.status === status), timeoutMs)
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function expectText(actual: string, expected: string): void {
  if (actual.trim() !== expected) throw new Error(`Unexpected artifact content: ${JSON.stringify(actual)}`)
}

function lastSeq(events: SessionEventEnvelope[]): number { return events.at(-1)?.seq ?? 0 }
function milestone(name: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ milestone: name, at: new Date().toISOString(), ...details }))
}
function argumentsFrom(values: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let index = 0; index < values.length; index += 2) result[values[index]!.replace(/^--/, '')] = values[index + 1] ?? ''
  return result
}
function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`)
  return value
}
