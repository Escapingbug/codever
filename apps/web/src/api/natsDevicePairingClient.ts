import {
  PROTOCOL_VERSION,
  clientPairingResponsesSubject,
  gatewayPairingRequestsSubject,
  parseDurablePairingResponseEnvelope,
  type DurablePairingRequestEnvelope,
  type DurablePairingResponseEnvelope,
} from '@codever/protocol'
import type { NatsConnection, Subscription } from '@nats-io/nats-core'
import type { DeviceSecureHandshake } from '../security/deviceSecureHandshake'

const STEP_RETRY_MS = 2_000
const PAIRING_TIMEOUT_MS = 3 * 60_000

/** Runs OPAQUE + HPKE provisioning over retry-stable NATS pairing subjects. */
export async function pairGatewayOverNats(input: {
  connection: NatsConnection
  gatewayId: string
  credentialId: string
  handshake: DeviceSecureHandshake
  timeoutMs?: number
  retryMs?: number
  now?: () => number
}): Promise<void> {
  const pairingSessionId = crypto.randomUUID()
  const now = input.now ?? Date.now
  const deadline = now() + (input.timeoutMs ?? PAIRING_TIMEOUT_MS)
  const pending = new Map<string, Deferred<DurablePairingResponseEnvelope>>()
  const subscription = input.connection.subscribe(clientPairingResponsesSubject(input.credentialId))
  const loop = consume(subscription, response => {
    if (response.gatewayId !== input.gatewayId
      || response.credentialId !== input.credentialId
      || response.pairingSessionId !== pairingSessionId) return
    pending.get(response.inReplyTo)?.resolve(response)
  })

  try {
    let output: string | undefined = await input.handshake.start()
    while (output) {
      const messageId = crypto.randomUUID()
      const request: DurablePairingRequestEnvelope = {
        version: PROTOCOL_VERSION,
        kind: 'codever.pairing.request',
        messageId,
        pairingSessionId,
        gatewayId: input.gatewayId,
        credentialId: input.credentialId,
        createdAt: new Date(now()).toISOString(),
        opaquePayload: output,
      }
      const waiting = deferred<DurablePairingResponseEnvelope>()
      pending.set(messageId, waiting)
      try {
        const response = await publishUntilResponse(
          input.connection, request, waiting.promise, deadline, now, input.retryMs ?? STEP_RETRY_MS,
        )
        output = await input.handshake.handle(response.opaquePayload)
      } finally {
        pending.delete(messageId)
      }
    }
    if (!input.handshake.ready) throw new Error('Gateway pairing ended before the secure credential was ready')
  } finally {
    subscription.unsubscribe()
    await loop.catch(() => undefined)
    for (const waiting of pending.values()) waiting.reject(new Error('Gateway pairing transport closed'))
  }
}

async function publishUntilResponse(
  connection: NatsConnection,
  request: DurablePairingRequestEnvelope,
  response: Promise<DurablePairingResponseEnvelope>,
  deadline: number,
  now: () => number,
  retryMs: number,
): Promise<DurablePairingResponseEnvelope> {
  const bytes = new TextEncoder().encode(JSON.stringify(request))
  while (now() < deadline) {
    connection.publish(gatewayPairingRequestsSubject(request.gatewayId), bytes)
    const result = await raceTimeout(response, Math.min(retryMs, deadline - now()))
    if (result) return result
  }
  throw new Error('Gateway pairing timed out; generate a fresh code and keep the Gateway online during pairing')
}

async function consume(
  subscription: Subscription,
  handler: (response: DurablePairingResponseEnvelope) => void,
): Promise<void> {
  for await (const message of subscription) {
    try {
      handler(parseDurablePairingResponseEnvelope(JSON.parse(new TextDecoder().decode(message.data))))
    } catch {
      // Ignore malformed or unrelated traffic on this credential-scoped subject.
    }
  }
}

function raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), Math.max(1, timeoutMs))
    void promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}
