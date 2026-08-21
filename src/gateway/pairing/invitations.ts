import {
  createDeviceInvitationLink,
  encodePairingLink,
  type MatrixLoginInvitation,
  type MatrixTransportBinding,
  type PairingOperation,
  type SignedPairingOffer,
} from '@codever/protocol'
import { FileTrustedDeviceRegistry, type PairingOfferSource } from './registry.js'
import { GatewayPairingService, pairingVerificationCode } from './service.js'

export type MatrixLoginMode = 'required' | 'preferred' | 'disabled'

export type MatrixLoginTokenIssueResult =
  | { status: 'ready'; invitation: MatrixLoginInvitation }
  | { status: 'reauth-required' }
  | { status: 'unsupported' }
  | { status: 'unavailable' }

export interface MatrixLoginTokenIssuer {
  issue(input: {
    homeserver: string
    offerExpiresAt: number
  }): Promise<MatrixLoginTokenIssueResult>
}

export interface CreateDeviceInvitationInput {
  source: PairingOfferSource
  lifetimeMs?: number
  matrixLogin?: MatrixLoginMode
  appUrl?: string
  allowedOperations?: PairingOperation[]
}

export interface CreatedDeviceInvitation {
  invitationId: string
  pairingLink: string
  invitationLink: string
  expiresAt: number
  verificationCode: string
  includesMatrixLogin: boolean
  matrixLoginStatus:
    | 'included'
    | 'disabled'
    | 'reauth-required'
    | 'unsupported'
    | 'unavailable'
}

export class DeviceInvitationError extends Error {
  constructor(
    readonly code:
      | 'too_many_open_invitations'
      | 'matrix_login_required'
      | 'pwa_url_required',
    message: string,
  ) {
    super(message)
    this.name = 'DeviceInvitationError'
  }
}

export interface DeviceInvitationCoordinatorOptions {
  gatewayName: string
  gatewayTransport: () => MatrixTransportBinding
  matrixLoginTokenIssuer?: MatrixLoginTokenIssuer
  maxOpenInvitations?: number
  now?: () => number
  onAudit?: (event: {
    action: 'created' | 'failed'
    source: PairingOfferSource
    invitationId?: string
    expiresAt?: number
    matrixLoginStatus?: CreatedDeviceInvitation['matrixLoginStatus']
    errorCode?: string
  }) => void
}

export class DeviceInvitationCoordinator {
  private chain: Promise<void> = Promise.resolve()
  private readonly maxOpenInvitations: number

  constructor(
    private readonly service: GatewayPairingService,
    private readonly registry: FileTrustedDeviceRegistry,
    private readonly options: DeviceInvitationCoordinatorOptions,
  ) {
    this.maxOpenInvitations = options.maxOpenInvitations ?? 3
    if (
      !Number.isSafeInteger(this.maxOpenInvitations)
      || this.maxOpenInvitations < 1
      || this.maxOpenInvitations > 100
    ) {
      throw new RangeError('maxOpenInvitations must be between 1 and 100')
    }
  }

  async create(input: CreateDeviceInvitationInput): Promise<CreatedDeviceInvitation> {
    const previous = this.chain
    let release!: () => void
    this.chain = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await this.createSerialized(input)
    } finally {
      release()
    }
  }

  private async createSerialized(
    input: CreateDeviceInvitationInput,
  ): Promise<CreatedDeviceInvitation> {
    const now = this.options.now?.() ?? Date.now()
    await this.registry.pruneOffers(now)
    if (input.source.kind === 'paired-device' && input.source.commandId) {
      const existing = await this.registry.findOfferBySource(input.source)
      if (existing) return recoveredPairedDeviceInvitation(existing)
    }
    const openOffers = (await this.registry.listOffers(now))
      .filter((offer) => offer.status === 'open')
    if (openOffers.length >= this.maxOpenInvitations) {
      const error = new DeviceInvitationError(
        'too_many_open_invitations',
        `At most ${this.maxOpenInvitations} pairing invitations may be open`,
      )
      this.auditFailure(input.source, error)
      throw error
    }

    const mode = input.matrixLogin ?? 'disabled'
    if (mode === 'required' && !input.appUrl) {
      const error = new DeviceInvitationError(
        'pwa_url_required',
        'A PWA URL is required for an invitation with Matrix login',
      )
      this.auditFailure(input.source, error)
      throw error
    }

    const created = await this.service.createOffer({
      gatewayName: this.options.gatewayName,
      gatewayTransport: this.options.gatewayTransport(),
      source: input.source,
      ...(input.lifetimeMs === undefined ? {} : { lifetimeMs: input.lifetimeMs }),
      ...(input.allowedOperations === undefined
        ? {}
        : { allowedOperations: input.allowedOperations }),
      now,
    })
    const offer = created.signedOffer.offer
    let loginResult: MatrixLoginTokenIssueResult = { status: 'unsupported' }
    if (
      mode !== 'disabled'
      && input.appUrl
      && this.options.matrixLoginTokenIssuer
    ) {
      try {
        loginResult = await this.options.matrixLoginTokenIssuer.issue({
          homeserver: offer.gatewayTransport.homeserver,
          offerExpiresAt: offer.expiresAt,
        })
      } catch (error) {
        await this.registry.cancelOffer(offer.offerId, now)
        this.options.onAudit?.({
          action: 'failed',
          source: input.source,
          invitationId: offer.offerId,
          errorCode: 'matrix_login_failed',
        })
        throw error
      }
    } else if (mode !== 'disabled' && !this.options.matrixLoginTokenIssuer) {
      loginResult = { status: 'unavailable' }
    } else if (mode !== 'disabled' && !input.appUrl) {
      loginResult = { status: 'unavailable' }
    }

    if (mode === 'required' && loginResult.status !== 'ready') {
      await this.registry.cancelOffer(offer.offerId, now)
      const error = new DeviceInvitationError(
        'matrix_login_required',
        matrixLoginFailureMessage(loginResult.status),
      )
      this.auditFailure(input.source, error)
      throw error
    }

    const generated =
      input.appUrl
        ? createDeviceInvitationLink({
            pairingLink: created.link,
            appUrl: input.appUrl,
            ...(loginResult.status === 'ready'
              ? { matrixLogin: loginResult.invitation }
              : {}),
          })
        : null
    const matrixLoginStatus =
      mode === 'disabled'
        ? 'disabled'
        : loginResult.status === 'ready'
          ? 'included'
          : loginResult.status
    const result: CreatedDeviceInvitation = {
      invitationId: offer.offerId,
      pairingLink: created.link,
      invitationLink: generated?.link ?? created.link,
      expiresAt: generated?.expiresAt ?? offer.expiresAt,
      verificationCode: await pairingVerificationCode(
        offer.offerId,
        offer.challenge,
        offer.gatewayKey.keyId,
      ),
      includesMatrixLogin: generated?.includesMatrixLogin ?? false,
      matrixLoginStatus,
    }
    this.options.onAudit?.({
      action: 'created',
      source: input.source,
      invitationId: result.invitationId,
      expiresAt: result.expiresAt,
      matrixLoginStatus,
    })
    return result
  }

  private auditFailure(source: PairingOfferSource, error: DeviceInvitationError): void {
    this.options.onAudit?.({
      action: 'failed',
      source,
      errorCode: error.code,
    })
  }
}

async function recoveredPairedDeviceInvitation(
  signedOffer: SignedPairingOffer,
): Promise<CreatedDeviceInvitation> {
  const offer = signedOffer.offer
  const pairingLink = encodePairingLink(signedOffer)
  return {
    invitationId: offer.offerId,
    pairingLink,
    invitationLink: pairingLink,
    expiresAt: offer.expiresAt,
    verificationCode: await pairingVerificationCode(
      offer.offerId,
      offer.challenge,
      offer.gatewayKey.keyId,
    ),
    includesMatrixLogin: false,
    matrixLoginStatus: 'disabled',
  }
}

function matrixLoginFailureMessage(
  status: Exclude<MatrixLoginTokenIssueResult['status'], 'ready'>,
): string {
  switch (status) {
    case 'reauth-required':
      return 'Matrix requires account reauthentication before issuing a login token'
    case 'unsupported':
      return 'The Matrix homeserver does not support one-time login tokens'
    case 'unavailable':
      return 'A Matrix login-token issuer is not configured'
  }
}
