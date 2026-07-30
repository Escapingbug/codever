import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  encodePairingLink,
  type PairingOffer,
} from "@codever/protocol";
import {
  exportPairingPublicKey,
  generateDeviceKeyPair,
  signPairingOffer,
} from "@codever/security";
import { POST } from "../app/api/invitations/route.ts";
import {
  clearInvitationRelayForTests,
  resolveEncryptedInvitation,
  storeEncryptedInvitation,
} from "../app/api/invitations/relayStore.ts";
import {
  resolveShortDeviceInvitation,
  shortenDeviceInvitation,
  type InvitationRelayClient,
} from "../app/invitationRelay.ts";
import { createDeviceInvitationLink } from "../app/pairing.ts";

const relayClient: InvitationRelayClient = {
  crypto: webcrypto as unknown as Crypto,
  fetch: (async (input, init) =>
    POST(new Request(input, init))) as typeof fetch,
};

test.beforeEach(() => clearInvitationRelayForTests());
test.afterEach(() => clearInvitationRelayForTests());

test("round-trips an encrypted invitation through a short fragment URL", async () => {
  const invitation = await generatedInvitation();
  const shortened = await shortenDeviceInvitation(
    invitation,
    "https://pwa.codever.example/settings?source=private#old=value",
    relayClient,
  );

  const shortUrl = new URL(shortened.link);
  const shortHash = new URLSearchParams(shortUrl.hash.slice(1));
  assert.equal(shortUrl.origin, "https://pwa.codever.example");
  assert.equal(shortUrl.pathname, "/settings");
  assert.equal(shortUrl.search, "");
  assert.match(shortHash.get("i") ?? "", /^[A-Za-z0-9_-]{22}$/u);
  assert.match(shortHash.get("k") ?? "", /^[A-Za-z0-9_-]{43}$/u);
  assert.ok(shortened.link.length < 120);
  assert.ok(shortened.link.length < invitation.link.length / 5);

  const storedResponse = await POST(
    new Request("https://pwa.codever.example/api/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "resolve",
        id: shortHash.get("i"),
      }),
    }),
  );
  const encryptedBody = await storedResponse.text();
  assert.equal(storedResponse.status, 200);
  assert.doesNotMatch(encryptedBody, /one-time-matrix-login-token/u);
  assert.doesNotMatch(encryptedBody, /codever\.pairing\.offer/u);

  assert.equal(
    await resolveShortDeviceInvitation(
      shortened.link,
      "https://pwa.codever.example/",
      relayClient,
    ),
    invitation.link,
  );
});

test("rejects a short invitation when its fragment key is changed", async () => {
  const invitation = await generatedInvitation();
  const shortened = await shortenDeviceInvitation(
    invitation,
    "https://pwa.codever.example/",
    relayClient,
  );
  const tampered = new URL(shortened.link);
  const hash = new URLSearchParams(tampered.hash.slice(1));
  const key = hash.get("k") ?? "";
  hash.set("k", `${key.startsWith("A") ? "B" : "A"}${key.slice(1)}`);
  tampered.hash = hash.toString();

  await assert.rejects(
    resolveShortDeviceInvitation(
      tampered.toString(),
      "https://pwa.codever.example/",
      relayClient,
    ),
    /could not be decrypted/u,
  );
});

test("removes expired entries from the in-memory invitation map", () => {
  const now = 1_800_000_000_000;
  const id = "a".repeat(22);
  assert.deepEqual(
    storeEncryptedInvitation(
      id,
      {
        ciphertext: "b".repeat(22),
        iv: "c".repeat(16),
        expiresAt: now + 1_000,
      },
      now,
    ),
    { status: "stored" },
  );
  assert.ok(resolveEncryptedInvitation(id, now + 999));
  assert.equal(resolveEncryptedInvitation(id, now + 1_000), null);
});

test("rejects oversized relay request bodies while streaming", async () => {
  const response = await POST(
    new Request("https://pwa.codever.example/api/invitations", {
      method: "POST",
      body: "x".repeat(49 * 1024),
    }),
  );
  assert.equal(response.status, 413);
});

async function generatedInvitation() {
  const issuedAt = Date.now();
  const keys = await generateDeviceKeyPair();
  const offer: PairingOffer = {
    kind: "codever.pairing.offer",
    version: 1,
    offerId: "relay-offer",
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
    challenge: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
    allowedOperations: [
      "prompt",
      "cancel",
      "decision",
      "session.settings",
      "session.create",
      "device.invite",
    ],
    issuedAt,
    expiresAt: issuedAt + 5 * 60_000,
  };
  const signed = await signPairingOffer(
    offer,
    keys.privateKey,
    keys.keyId,
  );
  return createDeviceInvitationLink({
    pairingLink: encodePairingLink(signed),
    appUrl: "https://pwa.codever.example/",
    matrixLogin: {
      homeserver: "https://matrix.example",
      userId: "@alice:example",
      loginToken: "one-time-matrix-login-token",
      expiresAt: offer.expiresAt,
    },
  });
}
