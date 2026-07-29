import {
  canonicalJson,
  createDeviceInvitationLink as createProtocolDeviceInvitationLink,
  decodeDeviceInvitationLink as decodeProtocolDeviceInvitationLink,
  decodePairingLink,
  pairingLinkFromDeviceInvitation as protocolPairingLinkFromDeviceInvitation,
  signedGatewayDeviceRotationSchema,
  signedPairingCertificateSchema,
  signedPairingOfferSchema,
  signedPairingRequestSchema,
  signedPairingResponseSchema,
  type MatrixTransportBinding,
  type DeviceInvitation,
  type GeneratedDeviceInvitation,
  type MatrixLoginInvitation,
  type PairingPublicKey,
  type SignedGatewayDeviceRotation,
  type SignedPairingCertificate,
  type SignedPairingOffer,
  type SignedPairingRequest,
  type SignedPairingResponse,
} from "@codever/protocol";
import {
  exportPairingPublicKey,
  pairingOfferDigest,
  signPairingRequest,
  verifyGatewayDeviceRotation,
  verifyPairingCertificate,
  verifyPairingOffer,
  verifyPairingRequest,
  verifyPairingResponse,
} from "@codever/security";
import type { DeviceIdentity } from "./matrix";

export const PAIRING_TRUST_STORAGE_KEY = "codever.pairing.trust.v1";
export const PENDING_PAIRING_STORAGE_KEY = "codever.pairing.pending.v1";
const PAIRING_REQUEST_TTL_MS = 2 * 60_000;
const PENDING_PAIRING_RETENTION_MS = 10 * 60_000;
const MAX_CLOCK_SKEW_MS = 30_000;

export type PairingPreview = {
  signedOffer: SignedPairingOffer;
  gatewayName: string;
  gatewayId: string;
  verificationCode: string;
  expiresAt: number;
  transport: MatrixTransportBinding;
};

export type {
  DeviceInvitation,
  GeneratedDeviceInvitation,
  MatrixLoginInvitation,
} from "@codever/protocol";

export type TrustedGateway = {
  version: 1;
  gatewayId: string;
  gatewayName: string;
  activeDeviceCount?: number;
  gatewayKey: PairingPublicKey;
  gatewayTransport: MatrixTransportBinding;
  offer: SignedPairingOffer;
  request: SignedPairingRequest;
  certificate: SignedPairingCertificate;
  rotations: SignedGatewayDeviceRotation[];
  pairedAt: number;
};

type PendingPairing = {
  version: 1;
  offer: SignedPairingOffer;
  request: SignedPairingRequest;
  savedAt: number;
};

export type PendingPairingRecovery =
  | { status: "ready"; preview: PairingPreview }
  | { status: "expired" };

export interface PairingTransport {
  exchange(
    request: SignedPairingRequest,
    offer: SignedPairingOffer,
    signal?: AbortSignal,
  ): Promise<SignedPairingResponse>;
}

export async function inspectPairingLink(
  input: string,
  now = Date.now(),
): Promise<PairingPreview> {
  const signedOffer = decodeFlexiblePairingLink(input.trim());
  const offer = await verifyPairingOffer(signedOffer, undefined, {
    now,
    maxFutureSkewMs: MAX_CLOCK_SKEW_MS,
  });
  return {
    signedOffer,
    gatewayName: offer.gatewayName,
    gatewayId: offer.gatewayId,
    verificationCode: await verificationCode(signedOffer),
    expiresAt: offer.expiresAt,
    transport: offer.gatewayTransport,
  };
}

export function createDeviceInvitationLink(input: {
  pairingLink: string;
  appUrl: string;
  matrixLogin?: MatrixLoginInvitation;
}): GeneratedDeviceInvitation {
  return createProtocolDeviceInvitationLink(input);
}

export function decodeDeviceInvitationLink(input: string): DeviceInvitation {
  return decodeProtocolDeviceInvitationLink(
    input,
    typeof window === "undefined"
      ? "https://codever.invalid/"
      : window.location.href,
  );
}

export function pairingLinkFromDeviceInvitation(
  invitation: DeviceInvitation,
): string {
  return protocolPairingLinkFromDeviceInvitation(invitation);
}

export async function completePairing(
  preview: PairingPreview,
  identity: DeviceIdentity,
  deviceTransport: MatrixTransportBinding,
  deviceName: string,
  transport: PairingTransport,
  signal?: AbortSignal,
): Promise<TrustedGateway> {
  const now = Date.now();
  const reusable = await loadReusablePendingRequest(
    preview,
    identity,
    deviceTransport,
    now,
  );
  let signedRequest = reusable?.request ?? null;
  const pendingSavedAt = reusable?.savedAt ?? now;
  if (!signedRequest) {
    if (preview.signedOffer.offer.expiresAt <= now) {
      throw new Error("This pairing invitation expired before it was confirmed.");
    }
    const offerDigest = await pairingOfferDigest(preview.signedOffer);
    const request = {
      kind: "codever.pairing.request" as const,
      version: 1 as const,
      requestId: crypto.randomUUID(),
      offerId: preview.signedOffer.offer.offerId,
      offerDigest,
      gatewayId: preview.gatewayId,
      deviceId: identity.keyId,
      deviceName: normalizeDeviceName(deviceName),
      deviceKey: await exportPairingPublicKey(identity.publicKey),
      deviceTransport,
      requestedOperations: preview.signedOffer.offer.allowedOperations,
      issuedAt: now,
      expiresAt: Math.min(preview.expiresAt, now + PAIRING_REQUEST_TTL_MS),
    };
    signedRequest = await signPairingRequest(
      request,
      preview.signedOffer,
      identity.privateKey,
      identity.keyId,
    );
  }
  savePendingPairing({
    version: 1,
    offer: preview.signedOffer,
    request: signedRequest,
    savedAt: pendingSavedAt,
  });

  const signedResponse = signedPairingResponseSchema.parse(
    await transport.exchange(signedRequest, preview.signedOffer, signal),
  );
  if (signedResponse.response.expiresAt <= Date.now()) {
    clearPendingPairing();
    throw new Error(
      "The saved pairing response expired. Scan a new Gateway QR code.",
    );
  }
  const response = await verifyPairingResponse(
    signedResponse,
    preview.signedOffer,
    signedRequest,
    { now: signedResponse.response.issuedAt },
  );

  const certificate = response.certificate;
  const trust: TrustedGateway = {
    version: 1,
    gatewayId: preview.gatewayId,
    gatewayName: preview.gatewayName,
    ...activeDeviceCountField(signedResponse.response),
    gatewayKey: preview.signedOffer.offer.gatewayKey,
    gatewayTransport: certificate.certificate.gatewayTransport,
    offer: preview.signedOffer,
    request: signedRequest,
    certificate,
    rotations: [],
    pairedAt: Date.now(),
  };
  clearPendingPairing();
  saveTrustedGateway(trust);
  return trust;
}

function activeDeviceCountField(
  input: unknown,
): { activeDeviceCount: number } | Record<string, never> {
  if (!input || typeof input !== "object") return {};
  const candidate = (input as Record<string, unknown>).activeDeviceCount;
  return typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate > 0
    ? { activeDeviceCount: candidate }
    : {};
}

export async function loadPendingPairingRecovery(
  identity: DeviceIdentity,
  now = Date.now(),
): Promise<PendingPairingRecovery | null> {
  const pending = readPendingPairing();
  if (!pending) return null;
  if (pending.savedAt + PENDING_PAIRING_RETENTION_MS <= now) {
    clearPendingPairing();
    return { status: "expired" };
  }
  try {
    await verifyPairingOffer(pending.offer, undefined, {
      now: pending.offer.offer.issuedAt,
    });
    await verifyPairingRequest(pending.request, pending.offer, {
      now: pending.request.request.issuedAt,
    });
    if (
      pending.request.request.deviceId !== identity.keyId ||
      pending.request.request.deviceKey.keyId !== identity.keyId
    ) {
      clearPendingPairing();
      return { status: "expired" };
    }
    return {
      status: "ready",
      preview: await previewFromOffer(
        pending.offer,
        pending.offer.offer.issuedAt,
        pending.savedAt + PENDING_PAIRING_RETENTION_MS,
      ),
    };
  } catch {
    clearPendingPairing();
    return { status: "expired" };
  }
}

export async function loadTrustedGateway(
  identity?: DeviceIdentity,
): Promise<TrustedGateway | null> {
  if (typeof localStorage === "undefined") return null;
  const value = localStorage.getItem(PAIRING_TRUST_STORAGE_KEY);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as TrustedGateway;
    const offer = signedPairingOfferSchema.parse(parsed.offer);
    const request = signedPairingRequestSchema.parse(parsed.request);
    const certificate = signedPairingCertificateSchema.parse(parsed.certificate);
    await verifyPairingOffer(offer, parsed.gatewayKey.publicKey, {
      now: offer.offer.issuedAt,
    });
    await verifyPairingRequest(request, offer, {
      now: request.request.issuedAt,
    });
    await verifyPairingCertificate(certificate, offer, request);
    if (
      identity &&
      (certificate.certificate.deviceId !== identity.keyId ||
        certificate.certificate.deviceKey.keyId !== identity.keyId)
    ) {
      return null;
    }
    const rotations = (parsed.rotations ?? []).map((rotation) =>
      signedGatewayDeviceRotationSchema.parse(rotation),
    );
    let expectedTransport = certificate.certificate.gatewayTransport;
    let previousIssuedAt = certificate.certificate.issuedAt;
    const rotationIds = new Set<string>();
    for (const signedRotation of rotations) {
      const rotation = await verifyGatewayDeviceRotation(
        signedRotation,
        parsed.gatewayKey.publicKey,
        {
          gatewayId: parsed.gatewayId,
          previousTransport: expectedTransport,
        },
        { now: signedRotation.rotation.issuedAt },
      );
      if (
        rotationIds.has(rotation.rotationId) ||
        rotation.issuedAt <= previousIssuedAt
      ) {
        return null;
      }
      rotationIds.add(rotation.rotationId);
      previousIssuedAt = rotation.issuedAt;
      expectedTransport = rotation.nextTransport;
    }
    if (
      parsed.version !== 1 ||
      !parsed.gatewayId ||
      !parsed.gatewayName ||
      !parsed.gatewayKey ||
      !parsed.gatewayTransport ||
      !parsed.offer ||
      !parsed.request ||
      !parsed.certificate ||
      certificate.certificate.expiresAt <= Date.now() ||
      certificate.certificate.gatewayId !== parsed.gatewayId ||
      certificate.certificate.gatewayKeyId !== parsed.gatewayKey.keyId ||
      canonicalJson(expectedTransport) !==
        canonicalJson(parsed.gatewayTransport)
    ) {
      return null;
    }
    return { ...parsed, offer, request, certificate, rotations };
  } catch {
    return null;
  }
}

export function saveTrustedGateway(trust: TrustedGateway): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PAIRING_TRUST_STORAGE_KEY, JSON.stringify(trust));
}

export function clearTrustedGateway(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(PAIRING_TRUST_STORAGE_KEY);
}

export function clearPendingPairing(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(PENDING_PAIRING_STORAGE_KEY);
}

export function trustedGatewayConfig(trust: TrustedGateway): {
  gatewayId: string;
  homeserver: string;
  roomId: string;
  gatewayMatrixUserId: string;
  gatewayMatrixDeviceId: string;
  gatewayMatrixEd25519: string;
} {
  return {
    gatewayId: trust.gatewayId,
    homeserver: trust.gatewayTransport.homeserver,
    roomId: trust.gatewayTransport.roomId,
    gatewayMatrixUserId: trust.gatewayTransport.userId,
    gatewayMatrixDeviceId: trust.gatewayTransport.deviceId,
    gatewayMatrixEd25519: trust.gatewayTransport.ed25519,
  };
}

function decodeFlexiblePairingLink(input: string): SignedPairingOffer {
  try {
    return decodePairingLink(input);
  } catch (firstError) {
    let data: string | null = null;
    try {
      const url = new URL(input, window.location.href);
      if (url.searchParams.has("pair") || url.searchParams.has("data")) {
        throw new Error("Query-string pairing links are not accepted.");
      }
      data = new URLSearchParams(url.hash.replace(/^#/, "")).get("pair");
    } catch {
      // The strict decoder below supplies the user-facing error.
    }
    if (!data) {
      throw new Error("Paste a complete Codever pairing link.", {
        cause: firstError,
      });
    }
    if (data.startsWith("codever://")) return decodePairingLink(data);
    return decodePairingLink(`codever://pair?data=${data}`);
  }
}

async function loadReusablePendingRequest(
  preview: PairingPreview,
  identity: DeviceIdentity,
  deviceTransport: MatrixTransportBinding,
  now: number,
): Promise<{ request: SignedPairingRequest; savedAt: number } | null> {
  const pending = readPendingPairing();
  if (!pending) return null;
  if (
    pending.offer.offer.offerId !== preview.signedOffer.offer.offerId ||
    canonicalJson(pending.offer) !== canonicalJson(preview.signedOffer)
  ) {
    return null;
  }
  if (
    pending.request.request.deviceId !== identity.keyId ||
    canonicalJson(pending.request.request.deviceTransport) !==
      canonicalJson(deviceTransport)
  ) {
    clearPendingPairing();
    throw new Error(
      "The saved pairing request belongs to another device. Scan a new Gateway QR code.",
    );
  }
  if (pending.savedAt + PENDING_PAIRING_RETENTION_MS <= now) {
    clearPendingPairing();
    throw new Error(
      "The previous pairing request expired. Scan a new Gateway QR code.",
    );
  }
  try {
    await verifyPairingRequest(pending.request, pending.offer, {
      now: pending.request.request.issuedAt,
    });
    return { request: pending.request, savedAt: pending.savedAt };
  } catch {
    clearPendingPairing();
    throw new Error(
      "The saved pairing request could not be verified. Scan a new Gateway QR code.",
    );
  }
}

function readPendingPairing(): PendingPairing | null {
  if (typeof localStorage === "undefined") return null;
  const value = localStorage.getItem(PENDING_PAIRING_STORAGE_KEY);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as PendingPairing;
    return {
      version: 1,
      offer: signedPairingOfferSchema.parse(parsed.offer),
      request: signedPairingRequestSchema.parse(parsed.request),
      savedAt:
        Number.isSafeInteger(parsed.savedAt) && parsed.savedAt >= 0
          ? parsed.savedAt
          : (() => {
              throw new Error("Invalid pending pairing timestamp.");
            })(),
    };
  } catch {
    clearPendingPairing();
    return null;
  }
}

function savePendingPairing(pending: PendingPairing): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PENDING_PAIRING_STORAGE_KEY, JSON.stringify(pending));
}

async function previewFromOffer(
  signedOffer: SignedPairingOffer,
  now: number,
  expiresAt = signedOffer.offer.expiresAt,
): Promise<PairingPreview> {
  const offer = await verifyPairingOffer(signedOffer, undefined, { now });
  return {
    signedOffer,
    gatewayName: offer.gatewayName,
    gatewayId: offer.gatewayId,
    verificationCode: await verificationCode(signedOffer),
    expiresAt,
    transport: offer.gatewayTransport,
  };
}

function normalizeDeviceName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return (normalized || "Codever PWA").slice(0, 128);
}

async function verificationCode(offer: SignedPairingOffer): Promise<string> {
  const digest = await sha256(
    new TextEncoder().encode(
      canonicalJson({
        offerId: offer.offer.offerId,
        challenge: offer.offer.challenge,
        gatewayKeyId: offer.offer.gatewayKey.keyId,
      }),
    ),
  );
  const number =
    (((digest[0] << 16) | (digest[1] << 8) | digest[2]) >>> 0) % 1_000_000;
  return number.toString().padStart(6, "0").replace(/(\d{3})(\d{3})/, "$1 $2");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
}
