import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeDeviceInvitationLink,
  type MatrixTransportBinding,
} from '@codever/protocol'
import {
  generateDeviceKeyPair,
  PairingOfferGuard,
} from '@codever/security'
import { FileReplayStore } from '@codever/security/node'
import {
  createSignedPairingRequest,
  DeviceInvitationCoordinator,
  FileGatewayIdentityStore,
  FileTrustedDeviceRegistry,
  GatewayPairingService,
} from '@/gateway/pairing'
import {
  FileMatrixLoginTokenIssuer,
  GatewayAdminClient,
  GatewayAdminClientError,
  startGatewayAdminServer,
  type GatewayAdminServer,
} from '@/gateway/admin'

const temporaryDirectories: string[] = []
const servers: GatewayAdminServer[] = []
const now = 1_900_000_000_000

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('Gateway local admin', () => {
  it('creates a PWA invitation with a one-time Matrix login and no access token', async () => {
    const fixture = await gatewayFixture()
    const coordinator = new DeviceInvitationCoordinator(
      fixture.service,
      fixture.registry,
      {
        gatewayName: 'Mac Gateway',
        gatewayTransport,
        now: () => now,
        matrixLoginTokenIssuer: {
          async issue() {
            return {
              status: 'ready',
              invitation: {
                homeserver: 'https://matrix.example',
                userId: '@pwa:example',
                loginToken: 'one-time-login-token',
                expiresAt: now + 2 * 60_000,
              },
            }
          },
        },
      },
    )

    const created = await coordinator.create({
      source: { kind: 'local-admin' },
      appUrl: 'https://pwa.example/settings?remove=me',
      matrixLogin: 'required',
    })

    const invitation = decodeDeviceInvitationLink(created.invitationLink)
    expect(invitation.matrixLogin).toMatchObject({
      userId: '@pwa:example',
      loginToken: 'one-time-login-token',
    })
    expect(created.expiresAt).toBe(now + 2 * 60_000)
    expect(created.invitationLink).not.toContain('access-token')
    await expect(fixture.registry.listOffers(now)).resolves.toEqual([
      expect.objectContaining({
        status: 'open',
        source: { kind: 'local-admin' },
      }),
    ])
  })

  it('serves status, idempotent invitations, cancellation, and owner-only socket permissions', async () => {
    const fixture = await gatewayFixture()
    const directory = await temporaryDirectory()
    const socketPath = join(directory, 'admin.sock')
    const coordinator = new DeviceInvitationCoordinator(
      fixture.service,
      fixture.registry,
      {
        gatewayName: 'Mac Gateway',
        gatewayTransport,
        now: () => now,
      },
    )
    const receiveWorkspaceFile = vi.fn(async (input: { requestId: string }) => ({
      fileId: input.requestId,
      eventId: 'workspace-file-event-1',
      delivery: 'delivered' as const,
    }))
    const server = await startGatewayAdminServer({
      socketPath,
      gatewayId: fixture.identity.gatewayId,
      coordinator,
      pairingService: fixture.service,
      registry: fixture.registry,
      getGatewayState: () => 'running',
      receiveWorkspaceFile,
      now: () => now,
    })
    servers.push(server)
    const client = new GatewayAdminClient({ socketPath })

    await expect(client.status()).resolves.toMatchObject({
      version: 1,
      state: 'running',
      activeDeviceCount: 0,
      openInvitationCount: 0,
    })
    const file = await client.sendFile(
      { path: '/tmp/report.pdf', caption: 'Generated report' },
      'workspace-file-key-0001',
    )
    await expect(client.sendFile(
      { path: '/tmp/report.pdf', caption: 'Generated report' },
      'workspace-file-key-0001',
    )).resolves.toEqual(file)
    expect(file).toMatchObject({
      fileId: 'workspace-file-key-0001',
      delivery: 'delivered',
    })
    expect(receiveWorkspaceFile).toHaveBeenCalledOnce()
    await expect(client.sendFile(
      { path: '/tmp/other.pdf' },
      'workspace-file-key-0001',
    )).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' })
    const first = await client.createInvitation(
      {
        matrixLogin: 'disabled',
        appUrl: 'https://pwa.example/',
      },
      'same-request-key-0001',
    )
    const retried = await client.createInvitation(
      {
        matrixLogin: 'disabled',
        appUrl: 'https://pwa.example/',
      },
      'same-request-key-0001',
    )
    expect(retried).toEqual(first)
    await expect(client.status()).resolves.toMatchObject({
      openInvitationCount: 1,
    })
    await expect(client.cancelInvitation(first.invitationId)).resolves.toEqual({
      ok: true,
      invitationId: first.invitationId,
    })
    await expect(client.status()).resolves.toMatchObject({
      openInvitationCount: 0,
    })
    const replacement = await client.createInvitation(
      {
        matrixLogin: 'disabled',
        appUrl: 'https://pwa.example/',
      },
      'same-request-key-0001',
    )
    expect(replacement.invitationId).not.toBe(first.invitationId)
    if (process.platform !== 'win32') {
      expect((await stat(socketPath)).mode & 0o777).toBe(0o600)
    }
  })

  it('revokes a paired device and refreshes live Gateway state', async () => {
    const fixture = await gatewayFixture()
    const offer = await fixture.service.createOffer({
      gatewayName: 'Mac Gateway',
      gatewayTransport: gatewayTransport(),
      now,
    })
    const request = await createSignedPairingRequest({
      signedOffer: offer.signedOffer,
      deviceId: 'phone-one',
      deviceName: 'Alice phone',
      deviceKeys: await generateDeviceKeyPair(),
      deviceTransport: deviceTransport(),
      now: now + 1_000,
    })
    await fixture.service.receiveRequest(request.signedRequest, now + 2_000)

    const directory = await temporaryDirectory()
    const socketPath = join(directory, 'admin.sock')
    const syncGatewayState = vi.fn(async () => undefined)
    const server = await startGatewayAdminServer({
      socketPath,
      gatewayId: fixture.identity.gatewayId,
      coordinator: new DeviceInvitationCoordinator(
        fixture.service,
        fixture.registry,
        {
          gatewayName: 'Mac Gateway',
          gatewayTransport,
          now: () => now + 3_000,
        },
      ),
      pairingService: fixture.service,
      registry: fixture.registry,
      getGatewayState: () => 'running',
      syncGatewayState,
      now: () => now + 3_000,
    })
    servers.push(server)
    const client = new GatewayAdminClient({ socketPath })

    await expect(client.revokeDevice('phone-one', {
      reason: 'lost device',
    })).resolves.toEqual({ ok: true, deviceId: 'phone-one' })
    expect(syncGatewayState).toHaveBeenCalledOnce()
    await expect(client.devices()).resolves.toEqual([
      expect.objectContaining({
        deviceId: 'phone-one',
        status: 'revoked',
        revocationReason: 'lost device',
      }),
    ])
  })

  it('rejects browser-origin requests and invitation floods', async () => {
    const fixture = await gatewayFixture()
    const directory = await temporaryDirectory()
    const socketPath = join(directory, 'admin.sock')
    const server = await startGatewayAdminServer({
      socketPath,
      gatewayId: fixture.identity.gatewayId,
      coordinator: new DeviceInvitationCoordinator(
        fixture.service,
        fixture.registry,
        {
          gatewayName: 'Mac Gateway',
          gatewayTransport,
          now: () => now,
          maxOpenInvitations: 10,
        },
      ),
      pairingService: fixture.service,
      registry: fixture.registry,
      getGatewayState: () => 'running',
      rateLimitPerMinute: 1,
      now: () => now,
    })
    servers.push(server)
    const client = new GatewayAdminClient({ socketPath })

    await expect(rawRequest(socketPath, {
      method: 'GET',
      path: '/v1/status',
      headers: { origin: 'https://attacker.example' },
    })).resolves.toMatchObject({
      status: 403,
      body: {
        error: { code: 'browser_origin_forbidden' },
      },
    })
    await client.createInvitation(
      { matrixLogin: 'disabled' },
      'rate-limit-key-0001',
    )
    await expect(client.createInvitation(
      { matrixLogin: 'disabled' },
      'rate-limit-key-0002',
    )).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
    } satisfies Partial<GatewayAdminClientError>)
  })

  it('uses a credential file only to exchange for a short-lived login token', async () => {
    const directory = await temporaryDirectory()
    const credentialsPath = join(directory, 'pwa-login.json')
    await writeFile(credentialsPath, JSON.stringify({
      user_id: '@pwa:example',
      access_token: 'long-lived-access-token',
    }))
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer long-lived-access-token',
      })
      return new Response(JSON.stringify({
        login_token: 'one-time-login-token',
        expires_in_ms: 60_000,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const issuer = new FileMatrixLoginTokenIssuer({
      credentialsPath,
      fetch,
      now: () => now,
    })

    await expect(issuer.issue({
      homeserver: 'https://matrix.example/path',
      offerExpiresAt: now + 5 * 60_000,
    })).resolves.toEqual({
      status: 'ready',
      invitation: {
        homeserver: 'https://matrix.example',
        userId: '@pwa:example',
        loginToken: 'one-time-login-token',
        expiresAt: now + 60_000,
      },
    })
  })

  it('expires and prunes abandoned pairing offers', async () => {
    const fixture = await gatewayFixture()
    await fixture.service.createOffer({
      gatewayName: 'Mac Gateway',
      gatewayTransport: gatewayTransport(),
      lifetimeMs: 30_000,
      now,
    })

    await expect(
      fixture.registry.pruneOffers(now + 30_001, 0),
    ).resolves.toEqual({ expired: 1, deleted: 1 })
    await expect(fixture.registry.listOffers(now + 30_001)).resolves.toEqual([])
  })

  it('recovers the same paired-device invitation by command id after restart', async () => {
    const fixture = await gatewayFixture()
    const input = {
      source: {
        kind: 'paired-device' as const,
        deviceId: 'trusted-device-1',
        commandId: 'device-invite-command-1',
      },
      matrixLogin: 'disabled' as const,
      lifetimeMs: 5 * 60_000,
    }
    const firstCoordinator = new DeviceInvitationCoordinator(
      fixture.service,
      fixture.registry,
      {
        gatewayName: 'Mac Gateway',
        gatewayTransport,
        now: () => now,
      },
    )
    const first = await firstCoordinator.create(input)

    const restartedCoordinator = new DeviceInvitationCoordinator(
      fixture.service,
      fixture.registry,
      {
        gatewayName: 'Mac Gateway',
        gatewayTransport,
        now: () => now + 1,
      },
    )
    const recovered = await restartedCoordinator.create(input)

    expect(recovered).toEqual(first)
    await expect(fixture.registry.listOffers(now + 1)).resolves.toEqual([
      expect.objectContaining({
        offerId: first.invitationId,
        status: 'open',
        source: input.source,
      }),
    ])
  })

  it('does not mint a second invitation when the same command is recovered after expiry', async () => {
    const fixture = await gatewayFixture()
    const input = {
      source: {
        kind: 'paired-device' as const,
        deviceId: 'trusted-device-1',
        commandId: 'expired-device-invite-command',
      },
      matrixLogin: 'disabled' as const,
      lifetimeMs: 30_000,
    }
    const first = await new DeviceInvitationCoordinator(
      fixture.service,
      fixture.registry,
      {
        gatewayName: 'Mac Gateway',
        gatewayTransport,
        now: () => now,
      },
    ).create(input)
    const recovered = await new DeviceInvitationCoordinator(
      fixture.service,
      fixture.registry,
      {
        gatewayName: 'Mac Gateway',
        gatewayTransport,
        now: () => now + 30_001,
      },
    ).create(input)

    expect(recovered).toEqual(first)
    await expect(fixture.registry.listOffers(now + 30_001)).resolves.toEqual([
      expect.objectContaining({
        offerId: first.invitationId,
        status: 'expired',
        source: input.source,
      }),
    ])
  })
})

async function gatewayFixture() {
  const directory = await temporaryDirectory()
  const registryPath = join(directory, 'registry.json')
  const identity = await new FileGatewayIdentityStore(
    join(directory, 'identity.json'),
  ).loadOrCreate('gateway-one', now)
  const registry = new FileTrustedDeviceRegistry(registryPath)
  const service = new GatewayPairingService(
    identity,
    registry,
    new PairingOfferGuard(
      new FileReplayStore(join(directory, 'replay.json')),
    ),
  )
  return { directory, identity, registry, service }
}

function gatewayTransport(): MatrixTransportBinding {
  return {
    homeserver: 'https://matrix.example',
    roomId: '!room:example',
    userId: '@gateway:example',
    deviceId: 'GATEWAY_DEVICE',
    ed25519: 'gateway-ed25519-public-key',
  }
}

function deviceTransport(): MatrixTransportBinding {
  return {
    homeserver: 'https://matrix.example',
    roomId: '!room:example',
    userId: '@pwa:example',
    deviceId: 'PWA_DEVICE',
    ed25519: 'pwa-ed25519-public-key',
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codever-admin-'))
  temporaryDirectories.push(directory)
  return directory
}

function rawRequest(
  socketPath: string,
  options: {
    method: string
    path: string
    headers?: Record<string, string>
  },
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath,
      method: options.method,
      path: options.path,
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 500,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        })
      })
    })
    request.once('error', reject)
    request.end()
  })
}
