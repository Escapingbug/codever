import type {
  Cvp3Command,
  Cvp3CommandOperation,
  SignedCvp3Command,
} from '@codever/protocol'
import { verifyCvp3Command } from '@codever/security'
import type { MatrixGatewayTrustedDevice } from './config'
import {
  FileCvp3CommandJournal,
  type Cvp3CommandClaim,
} from './fileCvp3CommandJournal'

export class MatrixCvp3CommandAuthorizer {
  constructor(
    private readonly workspaceId: string,
    private readonly journal: FileCvp3CommandJournal,
  ) {}

  async authorize(
    signed: SignedCvp3Command,
    device: MatrixGatewayTrustedDevice,
    roomId: string,
    projectId: string,
    matrixEventId?: string,
    now = Date.now(),
  ): Promise<{ command: Cvp3Command; claim: Cvp3CommandClaim }> {
    if (!device.allowedRoomIds.includes(roomId)) {
      throw new Error('Codever device is not allowed in this project room')
    }
    if (device.certificateExpiresAt !== undefined && device.certificateExpiresAt <= now) {
      throw new Error('Codever device certificate has expired')
    }
    const command = await verifyCvp3Command(signed, device.publicKey, {
      workspaceId: this.workspaceId,
      projectId,
      deviceId: device.deviceId,
      certificateId: device.sequenceEpoch,
      allowedOperations: v3AllowedOperations(device.allowedOperations),
    })
    return {
      command,
      claim: await this.journal.claim(
        command,
        now,
        matrixEventId ? { roomId, matrixEventId } : undefined,
      ),
    }
  }
}

function v3AllowedOperations(
  legacy: MatrixGatewayTrustedDevice['allowedOperations'],
): Cvp3CommandOperation[] | undefined {
  if (!legacy) return undefined
  const result = new Set<Cvp3CommandOperation>()
  for (const operation of legacy) {
    switch (operation) {
      case 'prompt': result.add('prompt.submit'); break
      case 'cancel': result.add('turn.cancel'); break
      case 'decision': result.add('decision.answer'); break
      case 'session.settings':
        result.add('session.update')
        result.add('project.update')
        break
      case 'session.create': result.add('session.create'); break
      case 'session.archive':
      case 'session.restore':
      case 'session.delete':
        result.add('session.set_lifecycle')
        break
      case 'device.invite': result.add('device.invitation.create'); break
    }
  }
  return [...result]
}
