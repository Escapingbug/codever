import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateDeviceKeyPair, signCvp3Command } from '@codever/security'
import { FileCvp3CommandJournal } from '@/gateway/matrix/fileCvp3CommandJournal'
import {
  MatrixCvp3CommandAuthorizer,
  canApprovePrivilegedExecution,
} from '@/gateway/matrix/cvp3Authorizer'

describe('MatrixCvp3CommandAuthorizer', () => {
  it('requires a separately granted capability for root approvals', () => {
    const device = {
      deviceId: 'device-1',
      publicKey: {} as JsonWebKey,
      allowedRoomIds: ['!project:example.org'],
      allowedOperations: ['prompt', 'decision'] as Array<'prompt' | 'decision'>,
      matrixUserId: '@owner:example.org',
      matrixDeviceId: 'PHONE',
      matrixDeviceKeys: ['matrix-phone-key'],
      certificateExpiresAt: Date.now() + 60_000,
      sequenceEpoch: 'certificate-1',
    }
    expect(canApprovePrivilegedExecution(device)).toBe(false)
    expect(canApprovePrivilegedExecution({
      ...device,
      allowedOperations: [...device.allowedOperations, 'privilege.approve'],
    })).toBe(true)
  })

  it('authorizes independent commands by certificate and command ID only', async () => {
    const keys = await generateDeviceKeyPair()
    const journal = new FileCvp3CommandJournal(
      join(await mkdtemp(join(tmpdir(), 'codever-v3-auth-')), 'journal.jsonl'),
    )
    await journal.initialize()
    const authorizer = new MatrixCvp3CommandAuthorizer('workspace-1', journal)
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
    const signed = await signCvp3Command(command, keys.privateKey, keys.keyId)
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
