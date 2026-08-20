import type {
  CodeverV3Command,
  CodeverV3CommandOperation,
  SignedCodeverV3Command,
} from '@codever/protocol'
import { verifyCodeverV3Command } from '@codever/security'
import type { MatrixGatewayTrustedDevice } from './config'
import {
  FileV3CommandJournal,
  type V3CommandClaim,
} from './fileV3CommandJournal'

export class V3MatrixCommandAuthorizer {
  constructor(
    private readonly workspaceId: string,
    private readonly journal: FileV3CommandJournal,
  ) {}

  async authorize(
    signed: SignedCodeverV3Command,
    device: MatrixGatewayTrustedDevice,
    roomId: string,
    projectId: string,
    matrixEventId?: string,
    now = Date.now(),
  ): Promise<{ command: CodeverV3Command; claim: V3CommandClaim }> {
    if (!device.allowedRoomIds.includes(roomId)) {
      throw new Error('Codever device is not allowed in this project room')
    }
    if (device.certificateExpiresAt !== undefined && device.certificateExpiresAt <= now) {
      throw new Error('Codever device certificate has expired')
    }
    const command = await verifyCodeverV3Command(signed, device.publicKey, {
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
): CodeverV3CommandOperation[] | undefined {
  if (!legacy) return undefined
  const result = new Set<CodeverV3CommandOperation>()
  for (const operation of legacy) {
    switch (operation) {
      case 'prompt': result.add('prompt.submit'); break
      case 'cancel': result.add('turn.cancel'); break
      case 'decision': result.add('decision.answer'); break
      case 'session.settings': result.add('session.update'); break
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
