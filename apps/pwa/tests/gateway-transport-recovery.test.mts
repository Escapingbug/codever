import assert from "node:assert/strict";
import test from "node:test";
import {
  exportPairingPublicKey,
  generateDeviceKeyPair,
  signGatewayTransportSnapshot,
} from "@codever/security";
import {
  applyGatewayTransportSnapshot,
  type TrustedGateway,
} from "../app/pairing.ts";

const now = 1_800_000_000_000;
const originalTransport = {
  homeserver: "https://matrix.example.org",
  roomId: "!codever:example.org",
  userId: "@gateway:example.org",
  deviceId: "GATEWAY_OLD",
  ed25519: "gateway-old-ed25519-fingerprint",
};

test("a durable root snapshot recovers across missed incremental rotations", async () => {
  const keys = await generateDeviceKeyPair();
  const currentTransport = {
    ...originalTransport,
    deviceId: "GATEWAY_CURRENT",
    ed25519: "gateway-current-ed25519-fingerprint",
  };
  const signed = await signGatewayTransportSnapshot(
    {
      kind: "codever.gateway.transport-snapshot",
      version: 1,
      snapshotId: "snapshot-current",
      gatewayId: "gateway-one",
      gatewayKeyId: keys.keyId,
      transport: currentTransport,
      issuedAt: now,
      expiresAt: now + 60_000,
    },
    keys.privateKey,
    keys.keyId,
  );
  const trust = {
    gatewayId: "gateway-one",
    gatewayKey: await exportPairingPublicKey(keys.publicKey),
    gatewayTransport: originalTransport,
    certificate: { certificate: { issuedAt: now - 10_000 } },
    rotations: [],
    transportSnapshots: [],
  } as unknown as TrustedGateway;

  const recovered = await applyGatewayTransportSnapshot(trust, signed, now);

  assert.deepEqual(recovered.gatewayTransport, currentTransport);
  assert.deepEqual(recovered.transportSnapshots, [signed]);
});

test("an older signed profile snapshot cannot roll transport trust back", async () => {
  const keys = await generateDeviceKeyPair();
  const currentTransport = {
    ...originalTransport,
    deviceId: "GATEWAY_CURRENT",
    ed25519: "gateway-current-ed25519-fingerprint",
  };
  const currentSnapshot = await signGatewayTransportSnapshot(
    {
      kind: "codever.gateway.transport-snapshot",
      version: 1,
      snapshotId: "snapshot-current",
      gatewayId: "gateway-one",
      gatewayKeyId: keys.keyId,
      transport: currentTransport,
      issuedAt: now,
      expiresAt: now + 60_000,
    },
    keys.privateKey,
    keys.keyId,
  );
  const staleSnapshot = await signGatewayTransportSnapshot(
    {
      kind: "codever.gateway.transport-snapshot",
      version: 1,
      snapshotId: "snapshot-stale",
      gatewayId: "gateway-one",
      gatewayKeyId: keys.keyId,
      transport: originalTransport,
      issuedAt: now - 1_000,
      expiresAt: now + 60_000,
    },
    keys.privateKey,
    keys.keyId,
  );
  const trust = {
    gatewayId: "gateway-one",
    gatewayKey: await exportPairingPublicKey(keys.publicKey),
    gatewayTransport: currentTransport,
    certificate: { certificate: { issuedAt: now - 10_000 } },
    rotations: [],
    transportSnapshots: [currentSnapshot],
  } as unknown as TrustedGateway;

  const unchanged = await applyGatewayTransportSnapshot(
    trust,
    staleSnapshot,
    now,
  );

  assert.equal(unchanged, trust);
  assert.deepEqual(unchanged.gatewayTransport, currentTransport);
});
