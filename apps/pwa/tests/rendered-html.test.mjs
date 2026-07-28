import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const appRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Codever agent workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Your agents, anywhere · Codever<\/title>/i);
  assert.match(html, /Matrix PWA rewrite/);
  assert.match(html, /Gateway online/);
  assert.match(html, /end-to-end encrypted/);
  assert.match(html, /Permission required/);
  assert.match(html, /Allow once/);
  assert.match(html, /Message Codex/);
  assert.match(html, /Real Matrix/);
  assert.match(html, /Connection mode/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/i);
});

test("ships a complete installable offline shell", async () => {
  const [manifestText, serviceWorker, source, styles] = await Promise.all([
    readFile(new URL("public/manifest.webmanifest", appRoot), "utf8"),
    readFile(new URL("public/sw.js", appRoot), "utf8"),
    readFile(new URL("app/CodeverApp.tsx", appRoot), "utf8"),
    readFile(new URL("app/globals.css", appRoot), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.name, "Codever — Secure Agent Workspace");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.ok(manifest.icons.length > 0);
  assert.match(serviceWorker, /caches\.open\(CACHE_NAME\)/);
  assert.match(serviceWorker, /event\.request\.mode === "navigate"/);
  assert.match(source, /navigator\.serviceWorker\?\.register\("\/sw\.js"\)/);
  assert.match(source, /setPermission\("approved"\)/);
  assert.match(source, /stopStreaming/);
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.match(styles, /\.mobile-chat-open \.conversation-panel/);
  await assert.rejects(access(new URL("app/_sites-preview", appRoot)));
});

test("pairs a Gateway without exposing Matrix fingerprints and signs strict commands", async () => {
  const [matrix, pairing, replayStore, wizard, settings, app, packageJson] = await Promise.all([
    readFile(new URL("app/matrix.ts", appRoot), "utf8"),
    readFile(new URL("app/pairing.ts", appRoot), "utf8"),
    readFile(new URL("app/IndexedDbReplayStore.ts", appRoot), "utf8"),
    readFile(new URL("app/PairingWizard.tsx", appRoot), "utf8"),
    readFile(new URL("app/MatrixSettings.tsx", appRoot), "utf8"),
    readFile(new URL("app/CodeverApp.tsx", appRoot), "utf8"),
    readFile(new URL("package.json", appRoot), "utf8"),
  ]);

  assert.match(packageJson, /"matrix-js-sdk": "41\.0\.0"/);
  assert.match(packageJson, /"@codever\/security"/);
  assert.match(matrix, /initRustCrypto\(\{/);
  assert.match(matrix, /useIndexedDB: true/);
  assert.match(matrix, /cryptoDatabasePrefix:/);
  assert.match(matrix, /indexedDB\.open\(DEVICE_DATABASE/);
  assert.match(matrix, /signCommand\(command, identity\.privateKey/);
  assert.match(matrix, /deviceId: identity\.keyId/);
  assert.match(matrix, /kind: "signed_command"/);
  assert.match(matrix, /signed_command: envelope/);
  assert.match(matrix, /sealSecureEnvelope\(\{/);
  assert.match(matrix, /openSecureEnvelope\(extension\.secure_envelope/);
  assert.match(matrix, /kind: "secure_envelope"/);
  assert.match(matrix, /body: "Encrypted Codever message"/);
  assert.match(matrix, /kind === "command_ack"/);
  assert.match(matrix, /waitForCommandAcknowledgement/);
  assert.match(matrix, /lastAcknowledged/);
  assert.match(matrix, /retryPendingCommand/);
  assert.match(matrix, /certificate\.certificate\.certificateId/);
  assert.match(matrix, /direction: "device_to_gateway"/);
  assert.match(matrix, /direction: "gateway_to_device"/);
  assert.match(matrix, /senderPublicKey: trust\.gatewayKey\.publicKey/);
  assert.match(matrix, /replayStore/);
  assert.match(
    matrix,
    /Legacy Matrix plaintext is intentionally ignored/,
  );
  assert.doesNotMatch(
    matrix,
    /parseCodeverEvent\([\s\S]{0,160}event\.getSender\(\)/,
  );
  assert.match(matrix, /globalBlacklistUnverifiedDevices = true/);
  assert.match(matrix, /AllDevicesIsolationMode/);
  assert.match(matrix, /gatewayMatrixEd25519/);
  assert.match(matrix, /setDeviceVerified/);
  assert.match(matrix, /getOwnDeviceKeys\(\)/);
  assert.match(matrix, /\/_matrix\/client\/v3\/account\/whoami/);
  assert.match(matrix, /sender === config\.userId/);
  assert.match(matrix, /error instanceof SecurityError && error\.code === "replay"/);
  assert.match(matrix, /Refusing to send to an unencrypted Matrix room/);
  assert.match(matrix, /kind: "pairing_request"/);
  assert.match(matrix, /verifyGatewayDeviceRotation/);
  assert.match(
    matrix,
    /verifyGatewayDeviceRotation[\s\S]*assertMatrixEventMatchesTransport\(event, rotation\.nextTransport\)/,
  );
  assert.match(
    matrix,
    /event\.getClaimedEd25519Key\(\) !== transport\.ed25519/,
  );
  assert.doesNotMatch(
    matrix,
    /event\.getClaimedEd25519Key\(\) !== trust\.gatewayTransport\.ed25519/,
  );
  assert.match(matrix, /saveTrustedGateway\(nextTrust\)/);
  assert.match(
    matrix,
    /trust\.rotations\.some[\s\S]*rotationId === signedRotation\.rotation\.rotationId/,
  );
  assert.match(
    matrix,
    /event\.isDecryptionFailure\(\)[\s\S]*seen\.add\(eventId\);[\s\S]*return;/,
  );
  assert.match(matrix, /localStorage\.setItem/);
  assert.doesNotMatch(matrix, /fetch\(["'`]\/api|server action|use server/i);
  assert.match(pairing, /verifyPairingOffer/);
  assert.match(pairing, /signPairingRequest/);
  assert.match(pairing, /verifyPairingResponse/);
  assert.match(pairing, /export async function loadTrustedGateway/);
  assert.match(pairing, /verifyPairingRequest/);
  assert.match(pairing, /verifyPairingCertificate/);
  assert.match(pairing, /await verifyGatewayDeviceRotation/);
  assert.match(pairing, /PAIRING_TRUST_STORAGE_KEY/);
  assert.match(pairing, /PENDING_PAIRING_STORAGE_KEY/);
  assert.match(pairing, /PENDING_PAIRING_RETENTION_MS = 10 \* 60_000/);
  assert.match(
    pairing,
    /savePendingPairing\([\s\S]*transport\.exchange\(signedRequest/,
  );
  assert.match(pairing, /clearPendingPairing\(\);\s*saveTrustedGateway/);
  assert.match(pairing, /loadPendingPairingRecovery/);
  assert.match(
    pairing,
    /verifyPairingResponse\([\s\S]*now: signedResponse\.response\.issuedAt/,
  );
  assert.match(
    pairing,
    /signedResponse\.response\.expiresAt <= Date\.now\(\)/,
  );
  assert.match(
    pairing,
    /previous pairing request expired\. Scan a new Gateway QR code/i,
  );
  assert.doesNotMatch(pairing, /function signDocument|function verifyDocument/);
  assert.match(replayStore, /class IndexedDbReplayStore implements ReplayStore/);
  assert.match(replayStore, /database\.transaction\(STORE_NAME, "readwrite"\)/);
  assert.match(replayStore, /claims\.some\(\(claim\) => activeKeys\.has\(claim\.key\)\)/);
  assert.match(wizard, /Scan QR code/);
  assert.match(wizard, /Paste from clipboard/);
  assert.match(wizard, /Invitation code/);
  assert.match(wizard, /Trust \$\{preview\.gatewayName\} and pair/);
  assert.match(wizard, /BarcodeDetector/);
  assert.match(settings, /Matrix carries/);
  assert.match(settings, /identified[\s\S]*automatically from the token/);
  assert.doesNotMatch(settings, /label: "Matrix account"|label: "This device"/);
  assert.doesNotMatch(settings, /Gateway Matrix user|Gateway Ed25519 fingerprint/);
  assert.match(app, /appMode.*"demo".*"matrix"/s);
  assert.match(app, /connectRealMatrix/);
  assert.match(app, /confirmPairing/);
  assert.match(app, /const link = hash\.get\("pair"\)/);
  assert.doesNotMatch(app, /searchParams\.get\("pair"\)/);
  assert.match(app, /url\.searchParams\.has\("pair"\)/);
  assert.match(app, /url\.searchParams\.delete\("pair"\)/);
  assert.doesNotMatch(pairing, /url\.searchParams\.get\("(?:pair|data)"\)/);
  assert.match(pairing, /url\.searchParams\.has\("pair"\)/);
  assert.match(app, /window\.history\.replaceState/);
  assert.match(app, /await loadTrustedGateway\(identity\)/);
  assert.match(app, /await loadPendingPairingRecovery\(identity\)/);
  assert.match(
    app,
    /await pairingRecoveryRef\.current\(preview, recoveryConfig\)/,
  );
  assert.match(matrix, /room\.getLiveTimeline\(\)\.getEvents\(\)/);
  assert.match(
    matrix,
    /`codever\.pair\.\$\{request\.request\.requestId\}\.\$\{crypto\.randomUUID\(\)\}`/,
  );
  assert.match(app, /sendRealCommand/);
});
