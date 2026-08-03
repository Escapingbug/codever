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

async function fetchBuiltRoute(pathname) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`),
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
  assert.match(html, /Add a Gateway/);
  assert.match(html, /Scan QR or paste a one-time pairing link/);
  assert.match(html, /Matrix E2EE \+ P-256/);
  assert.match(html, /Add a Gateway to start/);
  assert.doesNotMatch(html, />Demo</);
  assert.doesNotMatch(html, /Connection mode/);
  assert.doesNotMatch(html, /Permission required/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/i);
});

test("ships a complete installable offline shell", async () => {
  const [manifestText, serviceWorker, source, newSession, history, styles] = await Promise.all([
    readFile(new URL("public/manifest.webmanifest", appRoot), "utf8"),
    readFile(new URL("public/sw.js", appRoot), "utf8"),
    readFile(new URL("app/CodeverApp.tsx", appRoot), "utf8"),
    readFile(new URL("app/NewSessionDialog.tsx", appRoot), "utf8"),
    readFile(new URL("app/messageHistory.ts", appRoot), "utf8"),
    readFile(new URL("app/globals.css", appRoot), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.name, "Codever — Secure Agent Workspace");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.ok(manifest.icons.length > 0);
  assert.match(serviceWorker, /codever-shell-v7/);
  assert.match(serviceWorker, /caches\.open\(CACHE_NAME\)/);
  assert.match(serviceWorker, /event\.request\.mode === "navigate"/);
  assert.match(serviceWorker, /cache:\s*"no-store"/);
  assert.match(serviceWorker, /pathname\.startsWith\("\/_matrix\/"\)/);
  assert.match(
    serviceWorker,
    /pathname\.startsWith\("\/_matrix\/"\)[\s\S]*?return;/,
  );
  assert.match(serviceWorker, /pathname === "\/api\/version"/);
  assert.match(source, /registerPwaUpdates\(setPwaUpdateState\)/);
  assert.match(
    source,
    /if \(isNativeManagedMatrixConfig\(stored\)\)[\s\S]*connectCodeverClient\(stored, true, true\)/,
  );
  assert.match(source, /Updating Codever/);
  assert.match(source, /onCheckForUpdates/);
  assert.doesNotMatch(source, /const sessions:|const initialMessages|appMode/);
  assert.match(source, /operation: "session\.create"/);
  assert.match(source, /className="session-row session-create-pending"/);
  assert.match(source, /<strong>Creating session…<\/strong>/);
  assert.match(
    source,
    /setPendingSessionCreate\(input\);[\s\S]*?setNewSessionOpen\(false\);[\s\S]*?await waitForNextPaint\(\);[\s\S]*?operation: "session\.create"/,
  );
  assert.match(styles, /\.session-create-spinner\s*\{/);
  assert.match(
    source,
    /<button[\s\S]{0,160}?aria-label="Settings"[\s\S]{0,160}?onClick=\{\(\) => setSettingsOpen\(true\)\}/,
  );
  assert.doesNotMatch(source, /operation: "session\.select"/);
  assert.match(
    source,
    /function chooseSession\(id: string\)[\s\S]*?activateLocalSession\(id\)/,
  );
  assert.match(source, /agentActivitiesBySession/);
  assert.match(source, /setSessionAgentActivity\(sessionId/);
  assert.match(source, /pendingPromptSessionIdsRef\.current\.has\(sessionId\)/);
  assert.match(source, /deriveComposerState/);
  assert.match(source, /composerState\.mode === "queue"/);
  assert.match(source, /aria-label="Stop agent"|"Stop agent"/);
  assert.match(source, /disabled=\{!composerState\.canSend\}/);
  assert.match(styles, /\.composer-hint-ready\s*\{\s*display: none;/);
  assert.doesNotMatch(styles, /\.composer-hint\s*\{\s*display: none;/);
  assert.doesNotMatch(
    source,
    /\{isStreaming \? \([\s\S]{0,700}?key="send-message"/,
  );
  assert.doesNotMatch(source, /const \[isStreaming, setIsStreaming\]/);
  assert.match(source, /gatewayProjectKey/);
  assert.match(source, /changeReasoningEffort/);
  assert.match(newSession, /Gateway × Project/);
  assert.match(newSession, /Project names may repeat/);
  assert.match(newSession, /Reasoning effort/);
  assert.match(source, /stopStreaming/);
  assert.match(source, /onScroll=\{handleFeedScroll\}/);
  assert.match(source, /loadOlderHistory/);
  assert.match(source, /persistMessageHistoryPage/);
  assert.doesNotMatch(
    source,
    /if \(cachedMessages\.length > 0\) \{[\s\S]{0,240}?return;/,
  );
  assert.match(source, /History only · request not replayed/);
  assert.match(source, /findOptimisticMessageId/);
  assert.doesNotMatch(
    source,
    /local composer already rendered this prompt optimistically/,
  );
  assert.match(history, /codever-pwa-message-history/);
  assert.match(history, /loadMessageHistoryPage/);
  assert.match(history, /reconcileMessageHistory/);
  assert.match(history, /\["scope", "sessionId", "timestamp", "id"\]/);
  assert.match(
    styles,
    /@media \(max-width: 900px\), \(max-height: 610px\) and \(max-width: 1100px\)/,
  );
  assert.match(styles, /\.mobile-chat-open \.conversation-panel/);
  assert.match(styles, /Readable product type scale/);
  assert.match(styles, /\.bubble \{[\s\S]*?font-size: 15px/);
  assert.match(styles, /\.composer textarea \{[\s\S]*?font-size: 15px/);
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.composer textarea,[\s\S]*?font-size: 16px/,
  );
  await assert.rejects(access(new URL("app/_sites-preview", appRoot)));
});

test("publishes an authoritative uncached build version", async () => {
  const response = await fetchBuiltRoute("/api/version");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
  assert.equal(response.headers.get("cdn-cache-control"), "no-store");
  const body = await response.json();
  assert.match(body.buildVersion, /^[A-Za-z0-9._+-]+$/u);
});

test("keeps conversations inside the viewport with an independently scrollable feed", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("app/CodeverApp.tsx", appRoot), "utf8"),
    readFile(new URL("app/globals.css", appRoot), "utf8"),
  ]);
  const appShell = styles.match(/\.app-shell \{([\s\S]*?)\}/)?.[1] ?? "";
  const sessionPanel =
    styles.match(/\.session-panel \{([\s\S]*?)\}/)?.[1] ?? "";
  const conversationPanel =
    styles.match(/\.conversation-panel \{([\s\S]*?)\}/)?.[1] ?? "";
  const chatFeed = styles.match(/\.chat-feed \{([\s\S]*?)\}/)?.[1] ?? "";

  assert.match(appShell, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  assert.match(appShell, /height:\s*100dvh/);
  assert.match(appShell, /min-height:\s*0/);
  assert.match(sessionPanel, /min-height:\s*0/);
  assert.match(sessionPanel, /overflow:\s*hidden/);
  assert.match(conversationPanel, /min-height:\s*0/);
  assert.match(conversationPanel, /overflow:\s*hidden/);
  assert.match(chatFeed, /overflow-y:\s*auto/);
  assert.match(chatFeed, /touch-action:\s*pan-y/);
  assert.match(
    source,
    /followLatestRef\.current = isNearFeedBottom\(feed\)/,
  );
  assert.match(
    source,
    /function isNearFeedBottom[\s\S]*?scrollHeight - feed\.scrollTop - feed\.clientHeight <= 96/,
  );
  assert.doesNotMatch(source, /behavior:\s*"smooth"/);
});

test("renders safe Markdown and keeps consecutive tools in an accessible folded group", async () => {
  const [app, markdown, toolGroup, presentation, packageJson, styles] =
    await Promise.all([
      readFile(new URL("app/CodeverApp.tsx", appRoot), "utf8"),
      readFile(new URL("app/MarkdownContent.tsx", appRoot), "utf8"),
      readFile(new URL("app/ToolGroupCard.tsx", appRoot), "utf8"),
      readFile(new URL("app/presentation.ts", appRoot), "utf8"),
      readFile(new URL("package.json", appRoot), "utf8"),
      readFile(new URL("app/globals.css", appRoot), "utf8"),
    ]);

  assert.match(app, /<MarkdownContent content=\{message\.text \?\? ""\}/);
  assert.match(app, /<ToolGroupCard group=\{toolGroup\}/);
  assert.doesNotMatch(app, /JSON\.stringify\(message\.raw/);
  assert.match(markdown, /remarkPlugins=\{\[remarkGfm\]\}/);
  assert.match(markdown, /skipHtml/);
  assert.match(markdown, /rel="noopener noreferrer"/);
  assert.match(toolGroup, /aria-expanded=\{expanded\}/);
  assert.match(toolGroup, /group\.tools\.map/);
  assert.match(presentation, /const TOOL_LIMIT = 200/);
  assert.match(packageJson, /"react-markdown"/);
  assert.match(packageJson, /"remark-gfm"/);
  assert.match(styles, /\.markdown-content pre/);
  assert.match(styles, /\.tool-group-details/);
});

test("pairs a Gateway without exposing Matrix fingerprints and signs strict commands", async () => {
  const sessionDeleteDialog = await readFile(
    new URL("app/SessionDeleteDialog.tsx", appRoot),
    "utf8",
  );
  const [
    matrix,
    pairing,
    replayStore,
    wizard,
    qrScanning,
    qrDecodeFallback,
    settings,
    app,
    matrixAuth,
    chatMessages,
    invitationRelay,
    invitationRoute,
    relayStore,
    packageJson,
    codeverClient,
    webCodeverClient,
  ] = await Promise.all([
      readFile(new URL("app/matrix.ts", appRoot), "utf8"),
      readFile(new URL("app/pairing.ts", appRoot), "utf8"),
      readFile(new URL("app/IndexedDbReplayStore.ts", appRoot), "utf8"),
      readFile(new URL("app/PairingWizard.tsx", appRoot), "utf8"),
      readFile(new URL("app/qrScanning.ts", appRoot), "utf8"),
      readFile(new URL("app/qrDecodeFallback.ts", appRoot), "utf8"),
      readFile(new URL("app/MatrixSettings.tsx", appRoot), "utf8"),
      readFile(new URL("app/CodeverApp.tsx", appRoot), "utf8"),
      readFile(new URL("app/matrixAuth.ts", appRoot), "utf8"),
      readFile(new URL("app/chatMessages.ts", appRoot), "utf8"),
      readFile(new URL("app/invitationRelay.ts", appRoot), "utf8"),
      readFile(new URL("app/api/invitations/route.ts", appRoot), "utf8"),
      readFile(
        new URL("app/api/invitations/relayStore.ts", appRoot),
        "utf8",
      ),
      readFile(new URL("package.json", appRoot), "utf8"),
      readFile(new URL("app/client/CodeverClient.ts", appRoot), "utf8"),
      readFile(
        new URL("app/client/web/WebCodeverClient.ts", appRoot),
        "utf8",
      ),
    ]);

  assert.match(packageJson, /"matrix-js-sdk": "41\.0\.0"/);
  assert.match(packageJson, /"@codever\/security"/);
  assert.match(packageJson, /"jsqr": "1\.4\.0"/);
  assert.match(packageJson, /"qrcode": "1\.5\.4"/);
  assert.match(matrix, /initRustCrypto\(\{/);
  assert.doesNotMatch(matrix, /readonly client: MatrixClient/);
  assert.match(codeverClient, /disconnect\(\): Promise<void>/);
  assert.match(codeverClient, /dispose\(\): void/);
  assert.match(webCodeverClient, /createWebCodeverClient/);
  assert.match(webCodeverClient, /this\.transport\.stop\(\)/);
  assert.match(app, /codeverClientRef/);
  assert.match(app, /codeverClientRef\.current\?\.dispose\(\)/);
  assert.match(app, /disconnectingClient\?\.disconnect\(\)/);
  assert.match(matrix, /initialSyncLimit: matrixInitialSyncLimit/);
  assert.match(matrix, /Publishing this device’s encryption keys/);
  assert.match(
    matrix,
    /async pair[\s\S]*await startupReady[\s\S]*await ensureOwnMatrixDeviceKeysPublished\(\)/,
  );
  assert.doesNotMatch(
    matrix.slice(
      matrix.indexOf("await waitForInitialSync"),
      matrix.indexOf("const waitForCommandAcknowledgement"),
    ),
    /Publishing this device’s encryption keys/,
  );
  assert.match(matrix, /CRYPTO_INITIALIZATION_TIMEOUT_MS/);
  assert.match(
    matrix,
    /await waitForInitialSync[\s\S]*handlers\.onStatus\(\s*"securing"/,
  );
  assert.match(matrix, /readonly ready: Promise<void>/);
  assert.match(matrix, /ready: startupReady/);
  assert.equal(matrix.match(/forceDiscardSession\(/gu)?.length, 3);
  const recoveredGatewayEncryptionBranch = matrix.slice(
    matrix.indexOf("if (gatewayTransportChanged)"),
    matrix.indexOf("if (recoveringSyncCheckpoint)"),
  );
  assert.match(
    recoveredGatewayEncryptionBranch,
    /const cryptoApi = client\.getCrypto\(\);[\s\S]*if \(!cryptoApi\)[\s\S]*cryptoApi\.forceDiscardSession\(config\.roomId\)/,
  );
  assert.match(
    matrix,
    /if \(configuredGateway && activeTrust\)[\s\S]*verifyAndPinGatewayDevice/,
  );
  assert.match(
    matrix,
    /async pair[\s\S]*verifyAndPinGatewayDevice[\s\S]*createMatrixPairingTransport/,
  );
  assert.match(matrix, /new sdk\.IndexedDBStore\(\{/);
  assert.match(matrix, /store: syncStore/);
  assert.match(
    matrix,
    /createClient\([\s\S]*syncStore\.startup\(\)[\s\S]*initRustCrypto/,
  );
  assert.match(matrix, /checkpointMatrixSyncStore/);
  assert.match(matrix, /checkpointAndReleaseMatrixSyncStore/);
  assert.doesNotMatch(matrix, /destroyAndReleaseMatrixSyncStore/);
  assert.match(matrix, /shouldRecoverMatrixSyncCheckpoint/);
  assert.match(matrix, /acquireMatrixCryptoLock/);
  assert.match(matrix, /getSavedSyncToken\(\)/);
  assert.match(matrix, /assertPersistenceHealthy\(\)/);
  assert.match(matrix, /persistence degraded to memory/);
  assert.match(matrix, /state === "SYNCING" \|\| state === "PREPARED"/);
  assert.match(matrix, /signed Gateway Matrix device is not present/i);
  assert.ok(
    matrix.indexOf("getUserDeviceInfo([gateway.userId], false)") <
      matrix.indexOf("getUserDeviceInfo([gateway.userId], true)"),
  );
  assert.match(matrix, /useIndexedDB: true/);
  assert.match(matrix, /cryptoDatabasePrefix:/);
  assert.match(matrix, /indexedDB\.open\(DEVICE_DATABASE/);
  assert.match(matrix, /signCommand\(command, identity\.privateKey/);
  assert.match(matrix, /deviceId: identity\.keyId/);
  assert.match(matrix, /kind: "signed_command"/);
  assert.match(matrix, /signed_command: envelope/);
  assert.match(matrix, /sealSecureEnvelope\(\{/);
  assert.match(matrix, /openSecureEnvelope\(extension\.secure_envelope/);
  assert.match(matrix, /openSecureEnvelopeBundle\(/);
  assert.match(matrix, /kind === "secure_envelope_bundle"/);
  assert.match(matrix, /secure_envelope_bundle/);
  assert.match(matrix, /replaces_logical_event_id/);
  assert.match(matrix, /kind: "secure_envelope"/);
  assert.match(matrix, /body: "Encrypted Codever message"/);
  assert.match(matrix, /kind === "command_ack"/);
  assert.match(matrix, /baseRevision: reservation\.baseRevision/);
  assert.match(matrix, /kind === "revision_conflict"/);
  assert.match(matrix, /rebasePendingCommand/);
  assert.match(matrix, /confirmRevisionRetry\(commandId\)/);
  assert.match(matrix, /discardRevisionConflict\(commandId\)/);
  assert.match(matrix, /CommandRevisionConflictError/);
  assert.doesNotMatch(matrix, /transmitWithConflictRetry/);
  assert.match(
    matrix,
    /confirmRevisionRetry\(commandId\)[\s\S]*rebasePendingCommand/,
  );
  assert.match(
    matrix,
    /sequence: reservation\.sequence,[\s\S]*baseRevision: expectedRevision/,
  );
  assert.match(matrix, /kind === "collaboration_command"/);
  assert.match(matrix, /kind === "command_result"/);
  assert.match(matrix, /isPositiveInteger\(decryptedExtension\.sequence\)/);
  assert.match(matrix, /onAuthenticatedCommandResult/);
  assert.match(
    matrix,
    /await onCommandAcknowledged\([\s\S]*commandLifecycle\.recordResult\(result\)/,
  );
  assert.match(matrix, /completion: commandLifecycle\.waitForCompletion/);
  assert.match(matrix, /origin_device_name/);
  assert.match(matrix, /waitForCommandAcknowledgement/);
  assert.match(matrix, /lastAcknowledged/);
  assert.match(matrix, /retryPendingCommand/);
  assert.match(matrix, /const expired = command\.expiresAt <= Date\.now\(\)/);
  assert.match(
    matrix,
    /const samePayload =[\s\S]*JSON\.stringify\(recovered\.payload\) === JSON\.stringify\(payload\)/,
  );
  assert.match(
    matrix,
    /\(!recovered\.expired \|\|[\s\S]*retainsCommandUntilResultConsumed\(recovered\.payload\)[\s\S]*samePayload/,
  );
  assert.doesNotMatch(
    matrix,
    /A queued command expired before the Gateway confirmed it/,
  );
  assert.match(matrix, /certificate\.certificate\.certificateId/);
  assert.match(matrix, /direction: "device_to_gateway"/);
  assert.match(matrix, /direction: "gateway_to_device"/);
  assert.match(matrix, /signedSecureEnvelopeSchema\.safeParse/);
  assert.match(matrix, /signedSecureEnvelopeBundleSchema\.safeParse/);
  assert.match(matrix, /recipient\.recipientDeviceId === expected\.recipientDeviceId/);
  assert.match(matrix, /routed\.data\.envelope\.recipientDeviceId !== expected\.recipientDeviceId/);
  assert.match(matrix, /recipient\.recipientKeyId === expected\.recipientKeyId/);
  assert.match(matrix, /routed\.data\.envelope\.recipientKeyId !== expected\.recipientKeyId/);
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
  assert.match(matrixAuth, /\/_matrix\/client\/v1\/login\/get_token/);
  assert.match(matrixAuth, /type: TOKEN_LOGIN_TYPE/);
  assert.match(matrixAuth, /type: PASSWORD_LOGIN_TYPE/);
  assert.match(wizard, /Add another device/);
  assert.match(wizard, /One-time Codever device invitation QR code/);
  assert.match(wizard, /margin: 4/);
  assert.match(wizard, /width: 256/);
  assert.match(app, /shortenDeviceInvitation/);
  assert.match(app, /resolveShortDeviceInvitation/);
  assert.match(invitationRelay, /name: "AES-GCM"/);
  assert.match(invitationRelay, /url\.hash = new URLSearchParams/);
  assert.match(invitationRoute, /action === "store"/);
  assert.match(invitationRoute, /action === "resolve"/);
  assert.match(relayStore, /new Map<string, EncryptedInvitationRelayEntry>/);
  assert.match(relayStore, /INVITATION_RELAY_MAX_ENTRIES = 256/);
  assert.doesNotMatch(invitationRoute, /loginToken|accessToken|pairingLink/);
  assert.match(settings, /Sign in to Matrix/);
  assert.match(settings, /Advanced: use an access token/);
  assert.match(app, /operation: "device\.invite"/);
  assert.match(app, /error instanceof CommandAcknowledgementTimeoutError/);
  assert.match(app, /observeCommandCompletion/);
  assert.match(
    app,
    /parseGatewayInvitationResult\([\s\S]*requestMatrixLoginToken\(/,
  );
  assert.match(matrix, /sender === config\.userId/);
  assert.match(matrix, /error instanceof SecurityError && error\.code === "replay"/);
  assert.match(matrix, /Refusing to send to an unencrypted Matrix room/);
  assert.match(matrix, /kind: "pairing_request"/);
  assert.match(matrix, /applyGatewayDeviceRotation/);
  assert.match(pairing, /verifyGatewayDeviceRotation/);
  assert.match(matrix, /CODEVER_GATEWAY_TRANSPORT_PROFILE_FIELD/);
  assert.match(matrix, /recoverGatewayTransportSnapshot/);
  assert.match(matrix, /applyGatewayTransportSnapshot/);
  assert.match(pairing, /verifyGatewayTransportSnapshot/);
  assert.match(pairing, /transportSnapshots/);
  assert.match(matrix, /enqueueInboundEvent/);
  assert.match(
    matrix,
    /const startupReady = finishMatrixStartup\(\);[\s\S]*void startupReady\.catch/,
  );
  assert.match(app, /shouldReloadInterruptedMatrixStartup/);
  assert.match(app, /MATRIX_STARTUP_RECOVERY_SESSION_KEY/);
  assert.match(app, /matrixStartupGenerationRef/);
  assert.match(app, /window\.location\.reload\(\)/);
  assert.ok(
    matrix.indexOf("client.on(sdk.RoomEvent.Timeline, onTimeline)") >
      matrix.indexOf("const recoveredTrust = await recoverGatewayTransportSnapshot"),
  );
  assert.match(app, /waitForCommandCompletion\(sent\.completion\)/);
  assert.match(app, /connection\.recoverCommand\(sent\.commandId\)/);
  assert.match(app, /await connection\.releaseCommand\(commandId\)/);
  assert.match(
    matrix,
    /Refusing to recover command \$\{expectedCommandId\}/,
  );
  assert.match(
    matrix,
    /applyGatewayDeviceRotation\(trust, signedRotation\)[\s\S]*assertMatrixEventMatchesTransport\(event, rotation\.nextTransport\)/,
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
    pairing,
    /trust\.rotations\.some[\s\S]*rotationId === signedRotation\.rotation\.rotationId/,
  );
  assert.match(
    matrix,
    /event\.isDecryptionFailure\(\)[\s\S]*seen\.add\(eventId\);[\s\S]*return;/,
  );
  assert.match(matrix, /localStorage\.setItem/);
  assert.match(
    matrix,
    /config\.gatewayId,[\s\S]*identity\.keyId,[\s\S]*config\.conversationId,[\s\S]*sequenceEpoch/,
  );
  assert.doesNotMatch(
    matrix,
    /getClaimedEd25519Key\(\) !== gateway\.ed25519[\s\S]{0,600}pairing_response/,
  );
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
  assert.match(pairing, /MIN_PAIRING_START_WINDOW_MS = 15_000/);
  assert.match(
    pairing,
    /savePendingPairing\([\s\S]*transport\.exchange\(\s*signedRequest/,
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
  assert.match(matrix, /pairing_rejection/);
  assert.match(matrix, /verifyPairingRejection/);
  assert.match(pairing, /error instanceof PairingRejectedError/);
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
  assert.match(wizard, /capture="environment"/);
  assert.match(wizard, /Take photo/);
  assert.match(wizard, /Choose photo/);
  assert.match(wizard, /Invitation code/);
  assert.match(wizard, /Trust \$\{preview\.gatewayName\} and pair/);
  assert.match(wizard, /busy && progressDetail/);
  assert.match(settings, /progressDetail=\{progressDetail\}/);
  assert.match(app, /setConnectionDetail\(detail \?\? null\)/);
  assert.match(qrScanning, /BarcodeDetector/);
  assert.match(wizard, /decodeQrImageFile/);
  assert.match(qrScanning, /import\("\.\/qrDecodeFallback"\)/);
  assert.match(qrDecodeFallback, /jsQR/);
  assert.match(settings, /Matrix transports/);
  assert.match(settings, /creates a separate Matrix device session/);
  assert.match(settings, /never asks you to copy an access token/);
  assert.match(settings, /Advanced: use an access token/);
  assert.doesNotMatch(settings, /label: "Matrix account"|label: "This device"/);
  assert.doesNotMatch(settings, /Gateway Matrix user|Gateway Ed25519 fingerprint/);
  assert.match(app, /useState<GatewayStateSnapshot \| null>\(null\)/);
  assert.match(
    app,
    /setActiveDeviceCount\(state\.gatewayState\.activeDeviceCount\)/,
  );
  assert.doesNotMatch(app, /setActiveDeviceCount\(incoming\.activeDeviceCount\)/);
  assert.doesNotMatch(app, /const sessions:|const initialMessages|appMode/);
  assert.match(matrix, /parseGatewayStateExtension\(decryptedExtension\)/);
  assert.match(matrix, /loadCachedGatewayState\(/);
  assert.match(matrix, /gatewayStateRequestSchema\.parse\(\{/);
  assert.match(matrix, /kind: "gateway_state_request"/);
  assert.match(
    matrix,
    /client\.on\(sdk\.RoomEvent\.Timeline, onTimeline\);[\s\S]*await Promise\.all\(initialTimelineOperations\);[\s\S]*await requestGatewayStateSnapshot\(\)/,
  );
  assert.match(
    matrix,
    /state === "RECONNECTING" \|\| state === "CATCHUP"[\s\S]*refreshGatewayStateAfterReconnect = true/,
  );
  assert.match(matrix, /createGatewayStateCacheRecord\(/);
  assert.match(matrix, /parseGatewayStateCacheRecord\(/);
  assert.match(
    matrix,
    /cachedGatewayState[\s\S]*handlers\.onCollaborationState/,
  );
  assert.match(matrix, /revisionInitialized: false/);
  assert.match(matrix, /stateVersion < baselineStateVersion/);
  assert.match(matrix, /retiredRevisionEpochs/);
  assert.match(matrix, /gateway-epoch-v1/);
  assert.match(
    matrix,
    /function gatewayEpochScope[\s\S]*config\.gatewayId,[\s\S]*identity\.keyId,[\s\S]*config\.conversationId/,
  );
  assert.match(matrix, /epochStatus === "retired" \|\| epochStatus === "stale"/);
  assert.match(matrix, /revisionEpochGeneration/);
  assert.match(matrix, /changed epoch without advancing its generation/);
  assert.match(matrix, /lastAcknowledged: 0,[\s\S]*revisionEpoch,[\s\S]*stateVersion/);
  assert.match(matrix, /revisionEpoch: reservation\.revisionEpoch/);
  assert.match(matrix, /revision_epoch !== "string"/);
  assert.match(matrix, /assertMatchingRevisionEpoch/);
  assert.match(matrix, /Waiting for the current Gateway session state/);
  assert.doesNotMatch(app, />\s*Demo\s*</);
  assert.match(app, /connectCodeverClient/);
  assert.doesNotMatch(app, /connectMatrix/);
  assert.match(app, /confirmPairing/);
  assert.match(settings, /Native APK/);
  assert.match(settings, /connection-error-build/);
  assert.match(app, /onNativeRuntime/);
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
  assert.match(matrix, /loadHistoryPage\(sessionId/);
  assert.match(matrix, /loadRecentHistory\(sessionId/);
  assert.match(matrix, /kind: "codever\.history\.request"/);
  assert.match(matrix, /kind: "history_request"/);
  assert.match(matrix, /historyPageSchema\.parse/);
  assert.match(matrix, /createDetachedSerialDispatcher/);
  assert.doesNotMatch(matrix, /await onHistoryPage\?\.\(page\)/);
  assert.match(matrix, /historyRequestLifecycle\.idForKey\(key\)/);
  assert.match(
    app,
    /onHistoryRecovered\(page\)[\s\S]*if \(isCurrentStartup\(\)\) recoverLateHistory\(page\)/,
  );
  assert.match(app, /setHistoryError/);
  assert.doesNotMatch(matrix, /client\.scrollback\(room/);
  assert.match(matrix, /class DisplayOnlyReplayStore implements ReplayStore/);
  assert.match(matrix, /now: routed\.data\.envelope\.issuedAt/);
  assert.match(matrix, /sessionId: effectiveExtension\.session_id/);
  assert.match(
    matrix,
    /`codever\.pair\.\$\{request\.request\.requestId\}\.\$\{crypto\.randomUUID\(\)\}`/,
  );
  assert.match(app, /sendRealCommand/);
  assert.match(app, /sessionLifecyclePayload\(action, sessionId\)/);
  assert.match(app, /operation: "session\.archive"/);
  assert.match(app, /operation: "session\.restore"/);
  assert.match(app, /operation: "session\.delete"/);
  assert.match(app, /This session is archived/);
  assert.match(app, /Restore session/);
  assert.match(app, /Delete session/);
  assert.match(app, /clearSessionMessageHistory/);
  assert.match(sessionDeleteDialog, /role="alertdialog"/);
  assert.match(sessionDeleteDialog, /Existing encrypted Matrix events/);
  assert.match(chatMessages, /entry\.commandId === message\.commandId/);
  assert.match(app, /message\.originDeviceName/);
  assert.match(app, /Another device updated this session/);
  assert.match(app, /Review complete · send/);
  assert.match(app, /discardRevisionConflict/);
  assert.match(app, /error instanceof CommandRevisionConflictError/);
  assert.match(app, /completedCommandResultsRef/);
  assert.match(app, /await sent\.completion/);
  assert.match(app, /completion\?\.outcome === "succeeded"/);
  assert.match(
    app,
    /completedCommandResultsRef\.current\.delete\(result\.commandId\)[\s\S]*finishLocalPromptCommand\(sessionId\)/,
  );
  assert.match(
    app,
    /activePromptCommandsRef\.current\.get\(result\.commandId\)[\s\S]*finishLocalPromptCommand\(promptSessionId\)/,
  );
  assert.match(
    app,
    /function finishLocalPromptCommand\(sessionId: string\)[\s\S]*hasActivePromptCommand\(sessionId\)/,
  );
  assert.match(
    app,
    /acknowledgementTimeout\.commandId[\s\S]*activePromptCommandsRef\.current\.set/,
  );
});
