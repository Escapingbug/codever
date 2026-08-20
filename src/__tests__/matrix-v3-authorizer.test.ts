import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateDeviceKeyPair, signCodeverV3Command } from '@codever/security'
import { FileV3CommandJournal } from '@/gateway/matrix/fileV3CommandJournal'
import { V3MatrixCommandAuthorizer } from '@/gateway/matrix/v3Authorizer'

describe('V3MatrixCommandAuthorizer', () => {
  it('authorizes independent commands by certificate and command ID only', async () => {
    const keys = await generateDeviceKeyPair()
    const journal = new FileV3CommandJournal(
      join(await mkdtemp(join(tmpdir(), 'codever-v3-auth-')), 'journal.jsonl'),
    )
    await journal.initialize()
    const authorizer = new V3MatrixCommandAuthorizer('workspace-1', journal)
    const command = {
      kind: 'codever.command' as const,
      version: 3 as const,
      commandId: 'command-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      deviceId: 'device-1',
      certificateId: 'certificate-1',
      createdAt: 1,
      operation: 'prompt.submit' as const,
      payload: { operation: 'prompt.submit' as const, text: 'hello' },
    }
    const signed = await signCodeverV3Command(command, keys.privateKey, keys.keyId)
    const policy = {
      deviceId: 'device-1',
      publicKey: keys.publicJwk,
      allowedRoomIds: ['!project:example.org'],
      allowedOperations: ['prompt'] as Array<'prompt'>,
      matrixUserId: '@owner:example.org',
      matrixDeviceId: 'PHONE',
      matrixDeviceKeys: ['matrix-phone-key'],
      certificateExpiresAt: Date.now() + 60_000,
      sequenceEpoch: 'certificate-1',
    }
    await expect(authorizer.authorize(
      signed,
      policy,
      '!project:example.org',
      'project-1',
    )).resolves.toMatchObject({ claim: { kind: 'accepted' } })
    await expect(authorizer.authorize(
      signed,
      policy,
      '!project:example.org',
      'project-1',
    )).resolves.toMatchObject({ claim: { kind: 'duplicate' } })
  })
})

