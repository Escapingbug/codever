import assert from "node:assert/strict";
import test from "node:test";
import QRCode from "qrcode";
import {
  encodePairingLink,
  type PairingOffer,
} from "@codever/protocol";
import {
  exportPairingPublicKey,
  generateDeviceKeyPair,
  signPairingOffer,
} from "@codever/security";
import {
  createDeviceInvitationLink,
  decodeDeviceInvitationLink,
  pairingLinkFromDeviceInvitation,
} from "../app/pairing.ts";

test("combines one signed Gateway offer and one-time Matrix login into a fragment link", async () => {
  const offer = await signedOffer();
  const pairingLink = encodePairingLink(offer);
  const generated = createDeviceInvitationLink({
    pairingLink,
    appUrl: "https://pwa.codever.example/settings?source=secret#old=value",
    matrixLogin: {
      homeserver: "https://matrix.example",
      userId: "@alice:example",
      loginToken: "x".repeat(256),
      expiresAt: 1_800_000_240_000,
    },
  });

  const url = new URL(generated.link);
  assert.equal(url.origin, "https://pwa.codever.example");
  assert.equal(url.pathname, "/settings");
  assert.equal(url.search, "");
  assert.ok(url.hash.startsWith("#invite="));
  assert.equal(generated.expiresAt, 1_800_000_240_000);
  assert.equal(generated.includesMatrixLogin, true);

  const decoded = decodeDeviceInvitationLink(generated.link);
  assert.equal(decoded.matrixLogin?.loginToken, "x".repeat(256));
  assert.deepEqual(decoded.offer, offer);
  assert.equal(pairingLinkFromDeviceInvitation(decoded), pairingLink);
  assert.match(
    await QRCode.toDataURL(generated.link, { errorCorrectionLevel: "L" }),
    /^data:image\/png;base64,/,
  );
});

test("supports a Gateway-only invitation when get_login_token is unavailable", async () => {
  const offer = await signedOffer();
  const generated = createDeviceInvitationLink({
    pairingLink: encodePairingLink(offer),
    appUrl: "http://localhost:3000/",
  });

  const decoded = decodeDeviceInvitationLink(generated.link);
  assert.equal(decoded.matrixLogin, undefined);
  assert.equal(generated.includesMatrixLogin, false);
  assert.equal(generated.expiresAt, offer.offer.expiresAt);
});

test("rejects Matrix credentials for a different homeserver", async () => {
  const offer = await signedOffer();
  assert.throws(
    () =>
      createDeviceInvitationLink({
        pairingLink: encodePairingLink(offer),
        appUrl: "https://pwa.codever.example/",
        matrixLogin: {
          homeserver: "https://attacker.example",
          userId: "@alice:example",
          loginToken: "one-time-login-token",
          expiresAt: 1_800_000_240_000,
        },
      }),
    /does not match the Gateway homeserver/,
  );
});

async function signedOffer() {
  const keys = await generateDeviceKeyPair();
  const offer: PairingOffer = {
    kind: "codever.pairing.offer",
    version: 1,
    offerId: "offer-1",
    gatewayId: "gateway-1",
    gatewayName: "Development Gateway",
    gatewayKey: await exportPairingPublicKey(keys.publicKey),
    gatewayTransport: {
      homeserver: "https://matrix.example",
      roomId: "!room:example",
      userId: "@gateway:example",
      deviceId: "GATEWAY",
      ed25519: "gateway-ed25519-public-key",
    },
    challenge:
      "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
    allowedOperations: [
      "prompt",
      "cancel",
      "decision",
      "session.settings",
      "session.create",
      "device.invite",
    ],
    issuedAt: 1_800_000_000_000,
    expiresAt: 1_800_000_300_000,
  };
  return signPairingOffer(offer, keys.privateKey, keys.keyId);
}
