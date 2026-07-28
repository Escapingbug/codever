import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { FileReplayStore } from '@codever/security/node'
import { PairingOfferGuard } from '@codever/security'
import {
  FileGatewayIdentityStore,
  FileTrustedDeviceRegistry,
  GatewayPairingService,
  pairingVerificationCode,
} from '../src/gateway/pairing/index.js'

const defaultStateDirectory = join(homedir(), '.codever', 'pairing')
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    identity: { type: 'string', default: join(defaultStateDirectory, 'gateway-identity.json') },
    registry: { type: 'string', default: join(defaultStateDirectory, 'trusted-devices.json') },
    replay: { type: 'string', default: join(defaultStateDirectory, 'offer-replay.json') },
    'gateway-id': { type: 'string' },
    name: { type: 'string', default: 'Codever Gateway' },
    homeserver: { type: 'string' },
    room: { type: 'string' },
    'matrix-user': { type: 'string' },
    'matrix-device': { type: 'string' },
    'matrix-ed25519': { type: 'string' },
    request: { type: 'string' },
    device: { type: 'string' },
    reason: { type: 'string' },
  },
})

const action = positionals[0] ?? 'help'
if (action === 'help') {
  printHelp()
} else {
  await run()
}

async function run(): Promise<void> {
  const identity = await new FileGatewayIdentityStore(resolve(values.identity)).loadOrCreate(
    values['gateway-id'],
  )
  if (values['gateway-id'] && values['gateway-id'] !== identity.gatewayId) {
    throw new Error(
      `Persisted Gateway ID ${identity.gatewayId} does not match --gateway-id`,
    )
  }
  const registry = new FileTrustedDeviceRegistry(resolve(values.registry))
  const service = new GatewayPairingService(
    identity,
    registry,
    new PairingOfferGuard(new FileReplayStore(resolve(values.replay))),
  )

  switch (action) {
  case 'offer': {
    const created = await service.createOffer({
      gatewayName: values.name,
      gatewayTransport: {
        homeserver: required(values.homeserver, '--homeserver'),
        roomId: required(values.room, '--room'),
        userId: required(values['matrix-user'], '--matrix-user'),
        deviceId: required(values['matrix-device'], '--matrix-device'),
        ed25519: required(values['matrix-ed25519'], '--matrix-ed25519'),
      },
    })
    process.stdout.write(
      `${JSON.stringify({
        gatewayId: identity.gatewayId,
        gatewayKeyId: identity.keys.keyId,
        expiresAt: created.signedOffer.offer.expiresAt,
        verificationCode: await pairingVerificationCode(
          created.signedOffer.offer.offerId,
          created.signedOffer.offer.challenge,
          created.signedOffer.offer.gatewayKey.keyId,
        ),
        link: created.link,
      }, null, 2)}\n`,
    )
    break
  }
  case 'accept': {
    const requestPath = required(values.request, '--request')
    const request = JSON.parse(await readFile(resolve(requestPath), 'utf8')) as unknown
    const accepted = await service.receiveRequest(request)
    process.stdout.write(`${JSON.stringify(accepted.response, null, 2)}\n`)
    break
  }
  case 'list': {
    const active = await registry.listActive()
    process.stdout.write(
      `${JSON.stringify(active.map(({ certificate, activatedAt }) => ({
        deviceId: certificate.certificate.deviceId,
        deviceName: certificate.certificate.deviceName,
        keyId: certificate.certificate.deviceKey.keyId,
        matrixUserId: certificate.certificate.deviceTransport.userId,
        matrixDeviceId: certificate.certificate.deviceTransport.deviceId,
        activatedAt,
      })), null, 2)}\n`,
    )
    break
  }
  case 'revoke': {
    await service.revoke(
      required(values.device, '--device'),
      values.reason,
    )
    process.stdout.write('Device revoked.\n')
    break
  }
    default:
      printHelp()
  }
}

function printHelp(): void {
  process.stdout.write(`Usage:
  tsx scripts/matrix-pairing-gateway.ts offer --homeserver URL --room ROOM_ID \\
    --matrix-user USER_ID --matrix-device DEVICE_ID --matrix-ed25519 KEY
  tsx scripts/matrix-pairing-gateway.ts accept --request pairing-request.json
  tsx scripts/matrix-pairing-gateway.ts list
  tsx scripts/matrix-pairing-gateway.ts revoke --device DEVICE_ID [--reason TEXT]

State defaults to ~/.codever/pairing and may be relocated with --identity,
--registry, and --replay.
`)
}

function required(value: string | undefined, option: string): string {
  if (!value) throw new Error(`${option} is required`)
  return value
}
