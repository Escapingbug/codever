import {
  CVP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
  CVP3_MATRIX_PROJECT_POINTER_EVENT_TYPE,
  CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE,
  MAX_CODEVER_ATTACHMENT_BYTES,
  attachmentSchema,
  cvp3ProjectKeyGrantStateSchema,
  type CodeverAttachment,
} from "@codever/protocol";
import {
  decryptMedia,
  encryptMedia,
  sha256,
  toArrayBuffer,
  verifyCvp3Pointer,
} from "@codever/security";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events";
import { IndexedDbMatrixCvp3ClientStore } from "./IndexedDbMatrixCvp3ClientStore";
import {
  MatrixCvp3ReadModelRepairError,
  MatrixCvp3ProtocolClient,
  type MatrixCvp3RawEvent,
} from "./matrixCvp3Client";
import { MatrixCvp3Readiness } from "./matrixCvp3Readiness";
import {
  acquireMatrixCryptoLock,
  flushAndReleaseMatrixSyncStore,
  flushMatrixSyncStore,
  matrixCryptoLockName,
  matrixSyncDatabaseName,
  waitForMatrixSyncStoreClose,
} from "./matrixSyncStore";
import {
  getOrCreateDeviceIdentity,
  normalizeMatrixConfig,
  createMatrixPairingTransport,
  verifyAndPinGatewayDevice,
  waitForInitialSync,
  waitForOwnMatrixDeviceKeys,
  withMatrixTimeout,
  type CollaborationState,
  type IncomingCodeverMessage,
  type MatrixConnection,
  type MatrixConnectionConfig,
  type MatrixConnectionStatus,
  type MatrixHistoryPage,
} from "./matrix";
import {
  completePairing,
  loadTrustedGateway,
  type PairingPreview,
  type TrustedGateway,
} from "./pairing";
import {
  parseToolGroupPresentation,
  type ToolGroupPresentation,
} from "./presentation";
import type { CommandCompletion } from "./commandLifecycle";
import {
  parseGatewayCapabilities,
  type GatewayStateSnapshot,
} from "./gatewayState";
import {
  MATRIX_PROJECT_AUTHORIZATION_REPAIR_REQUIRED,
  resolveAuthoritativeProjectKeyGrant,
} from "./projectKeyGrantRecovery";

const LOCAL_TIMEOUT_MS = 10_000;
const INITIAL_SYNC_LIMIT = 32;

type V3Handlers = {
  onMessage(message: IncomingCodeverMessage): void;
  onStatus(status: MatrixConnectionStatus, detail?: string): void;
  onTrustUpdated?(trust: TrustedGateway): void;
  onCollaborationState?(state: CollaborationState): void;
  onCommandResult?(result: CommandCompletion): void;
  onHistoryRecovered?(page: { sessionId: string; messages: IncomingCodeverMessage[]; hasMore: boolean }): void;
  onConvergenceRequired?(): void;
};

/** Matrix SDK transport host for the CVP/3 core. */
export async function connectMatrixCvp3(
  configInput: MatrixConnectionConfig,
  handlers: V3Handlers,
): Promise<MatrixConnection> {
  const config = normalizeMatrixConfig(configInput);
  handlers.onStatus("connecting", "Opening the durable CVP/3 client…");
  const identity = await getOrCreateDeviceIdentity();
  let trust = await loadTrustedGateway(identity);
  const sdk = await import("matrix-js-sdk");
  const syncDatabase = await matrixSyncDatabaseName(config);
  await waitForMatrixSyncStoreClose(syncDatabase);
  const syncStore = new sdk.IndexedDBStore({ indexedDB, dbName: syncDatabase });
  const cryptoScope = await matrixCryptoLockName(config);
  const cryptoLock = await acquireMatrixCryptoLock(cryptoScope);
  const client = sdk.createClient({
    baseUrl: config.homeserver,
    userId: config.userId,
    accessToken: config.accessToken,
    deviceId: config.matrixDeviceId,
    timelineSupport: true,
    store: syncStore,
  });
  let stopped = false;
  let room: Room | null = null;
  let protocol: MatrixCvp3ProtocolClient | null = null;
  let projectId: string | null = null;
  let matrixDeviceKeys: { ed25519: string; curve25519: string } | null = null;
  const readiness = new MatrixCvp3Readiness(Boolean(trust));
  let authoritativeProjectionPrepared = false;
  let cachedProjectionPublished = false;
  const deliveredMessages = new Map<string, { version: number; physicalEventId: string }>();
  const emittedCompletions = new Set<string>();
  const deliveredHistory = new Map<string, Set<string>>();
  const historyTokens = new Map<string, string | null>();
  const historyInitialized = new Set<string>();
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const completeReady = () => {
    if (readySettled) return;
    readySettled = true;
    resolveReady();
  };
  const failReady = (error: unknown) => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(error);
  };

  const publishProjection = () => {
    const active = protocol;
    if (!active) return;
    for (const message of active.projection.messages.values()) {
      const previous = deliveredMessages.get(message.logicalId);
      if (
        previous
        && previous.version === message.version
        && previous.physicalEventId === message.physicalEventId
      ) continue;
      deliveredMessages.set(message.logicalId, {
        version: message.version,
        physicalEventId: message.physicalEventId,
      });
      handlers.onMessage(toIncomingMessage(message, previous?.physicalEventId));
    }
    for (const completion of active.projection.completions.values()) {
      if (emittedCompletions.has(completion.commandId)) continue;
      emittedCompletions.add(completion.commandId);
      handlers.onCommandResult?.(toLegacyCompletion(completion));
    }
    handlers.onCollaborationState?.({
      activeDeviceCount: trust?.activeDeviceCount,
      revision: 0,
      gatewayState: gatewayState(active, config, trust),
    });
  };

  const publishProjectionIfAuthoritative = () => {
    if (readiness.canPublishAuthoritativeProjection) publishProjection();
  };

  const publishCachedProjectionIfAvailable = () => {
    const active = protocol;
    if (
      cachedProjectionPublished
      || readiness.canPublishAuthoritativeProjection
      || !active
      || (
        !active.projection.workspace
        && !active.projection.project
        && active.projection.sessions.size === 0
        && active.projection.messages.size === 0
        && active.projection.inboxFiles.size === 0
      )
    ) return;
    cachedProjectionPublished = true;
    publishProjection();
  };

  const createProtocol = async (grantInput: unknown): Promise<boolean> => {
    if (!trust) return false;
    const grant = cvp3ProjectKeyGrantStateSchema.parse(grantInput);
    if (
      grant.workspaceId !== config.gatewayId
      || grant.roomId !== config.roomId
      || grant.deviceId !== identity.keyId
      || grant.certificateId !== trust.certificate.certificate.certificateId
    ) return false;
    projectId = grant.projectId;
    if (!protocol) {
      const store = new IndexedDbMatrixCvp3ClientStore([
        config.gatewayId,
        config.roomId,
        grant.projectId,
        identity.keyId,
        grant.certificateId,
      ].join("\u0000"));
      protocol = new MatrixCvp3ProtocolClient(
        {
          workspaceId: config.gatewayId,
          roomId: config.roomId,
          projectId: grant.projectId,
        },
        identity,
        trust,
        {
          async sendMessage(request) {
            return {
              eventId: await sendMatrixCvp3ApplicationEvent(
                client,
                request.roomId,
                request.content as unknown as RoomMessageEventContent,
                request.transactionId,
              ),
            };
          },
        },
        store,
        publishProjectionIfAuthoritative,
        (_event, error) => {
          // Per-event quarantine is intentionally non-fatal. Diagnostics keep
          // the exact error while the following event continues projecting.
          console.error("[cvp3/matrix] quarantined timeline event", error);
        },
      );
    }
    await protocol.initialize();
    await protocol.acceptKeyGrant(grant);
    await protocol.drainInbox();
    if (readiness.canPublishAuthoritativeProjection) {
      await protocol.retryPending();
      publishProjection();
    } else {
      // A non-empty durable projection remains useful for offline reading, but
      // an absent/rebuilt projection cannot be presented as an authoritative
      // empty Gateway while current snapshots are still being fetched.
      publishCachedProjectionIfAvailable();
    }
    return true;
  };

  const scanGrantState = async (): Promise<boolean> => {
    const currentRoom = room ?? client.getRoom(config.roomId);
    if (!currentRoom || !trust) return false;
    const states = currentRoom.currentState.getStateEvents(
      CVP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
    );
    const candidates = Array.isArray(states) ? states : states ? [states] : [];
    for (const event of candidates) {
      const parsed = cvp3ProjectKeyGrantStateSchema.safeParse(event.getContent());
      if (
        parsed.success
        && parsed.data.workspaceId === config.gatewayId
        && parsed.data.deviceId === identity.keyId
        && parsed.data.certificateId === trust.certificate.certificate.certificateId
      ) {
        await createProtocol(parsed.data);
        return true;
      }
    }
    return false;
  };

  const authoritativeProjectId = async (): Promise<string> => {
    if (!trust) throw new Error("This device has not approved a Gateway.");
    const content = await client.getStateEvent(
      config.roomId,
      CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE,
      config.gatewayId,
    );
    const pointer = await verifyCvp3Pointer(
      content,
      trust.gatewayKey.publicKey,
    );
    if (
      pointer.kind !== "workspace.current"
      || pointer.workspaceId !== config.gatewayId
      || !pointer.projectId
      || pointer.roomId !== config.roomId
      || pointer.gatewayKeyId !== trust.gatewayKey.keyId
    ) {
      throw new Error(
        "The authoritative workspace pointer is bound to another Gateway or room.",
      );
    }
    return pointer.projectId;
  };

  const openAuthoritativeProjectGrant = async (): Promise<boolean> => {
    if (!trust) return false;
    const currentProjectId = await authoritativeProjectId();
    let content: unknown | null;
    try {
      content = await client.getStateEvent(
        config.roomId,
        CVP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
        `${currentProjectId}.${identity.keyId}`,
      );
    } catch (error) {
      if (!isMatrixNotFound(error)) throw error;
      content = null;
    }
    const resolution = resolveAuthoritativeProjectKeyGrant(content, {
      workspaceId: config.gatewayId,
      projectId: currentProjectId,
      roomId: config.roomId,
      deviceId: identity.keyId,
      certificateId: trust.certificate.certificate.certificateId,
    });
    if (resolution.kind === "reauthorization-required") return false;
    return createProtocol(resolution.grant);
  };

  const ingestEvent = async (event: MatrixEvent): Promise<void> => {
    if (event.isEncrypted() || event.getType() === "m.room.encrypted") {
      await client.decryptEventIfNeeded(event);
    }
    if (event.isDecryptionFailure() || event.getType() !== "m.room.message") return;
    const eventId = event.getId();
    const sender = event.getSender();
    if (!eventId || !sender) return;
    const raw: MatrixCvp3RawEvent = {
      roomId: config.roomId,
      eventId,
      sender,
      timestamp: event.getTs(),
      content: event.getContent() as Record<string, unknown>,
    };
    const active = protocol;
    if (!active) {
      return;
    }
    await active.ingest(raw);
  };

  const recoverCurrentProjectSnapshot = async (): Promise<boolean> => {
    if (!trust || !protocol || !projectId) return false;
    const content = await client.getStateEvent(
      config.roomId,
      CVP3_MATRIX_PROJECT_POINTER_EVENT_TYPE,
      projectId,
    );
    const pointer = await verifyCvp3Pointer(
      content,
      trust.gatewayKey.publicKey,
    );
    if (
      pointer.kind !== "project.current"
      || pointer.workspaceId !== config.gatewayId
      || pointer.projectId !== projectId
      || pointer.roomId !== config.roomId
      || pointer.gatewayKeyId !== trust.gatewayKey.keyId
    ) throw new Error("The CVP/3 project pointer is bound to another Gateway or room.");
    const raw = await client.fetchRoomEvent(config.roomId, pointer.eventId);
    await ingestEvent(new sdk.MatrixEvent(raw));
    return true;
  };

  const recoverCurrentWorkspaceSnapshot = async (): Promise<boolean> => {
    if (!trust || !protocol || !projectId) return false;
    const content = await client.getStateEvent(
      config.roomId,
      CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE,
      config.gatewayId,
    );
    const pointer = await verifyCvp3Pointer(
      content,
      trust.gatewayKey.publicKey,
    );
    if (
      pointer.kind !== "workspace.current"
      || pointer.workspaceId !== config.gatewayId
      || pointer.projectId !== projectId
      || pointer.roomId !== config.roomId
      || pointer.gatewayKeyId !== trust.gatewayKey.keyId
    ) throw new Error("The CVP/3 workspace pointer is bound to another Gateway or room.");
    const raw = await client.fetchRoomEvent(config.roomId, pointer.eventId);
    await ingestEvent(new sdk.MatrixEvent(raw));
    return true;
  };

  let inboundChain = Promise.resolve();
  let recoveryChain = Promise.resolve();
  const enqueue = (event: MatrixEvent): void => {
    inboundChain = inboundChain.then(() => ingestEvent(event)).catch(error => {
      console.error("[cvp3/matrix] an application event could not be ingested", error);
      handlers.onStatus("error", "matrix_event_ingest_failed");
    });
  };
  const onMatrixEvent = (event: MatrixEvent) => {
    // Room.timeline is not an exhaustive sync feed: matrix-js-sdk routes
    // m.thread replies into per-thread timelines, and may omit them from the
    // room listener when the root is outside its active window. ClientEvent
    // delivers every event seen by /sync; the durable inbox then deduplicates
    // main-timeline, thread, and explicit-history copies by physical event ID.
    if (stopped || event.getRoomId() !== config.roomId) return;
    enqueue(event);
  };
  const onRoomState = (event: MatrixEvent) => {
    if (event.getType() === CVP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE) {
      void createProtocol(event.getContent())
        .then(opened => opened ? recoverAuthoritativeState() : undefined)
        .catch(error => {
          reportRecoveryFailure("The project key grant could not be opened", error);
        });
      return;
    }
    if (
      event.getType() === CVP3_MATRIX_PROJECT_POINTER_EVENT_TYPE
      || event.getType() === CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE
    ) {
      void recoverAuthoritativeState().catch(error => {
        reportRecoveryFailure("The current CVP/3 snapshots could not be recovered", error);
      });
    }
  };
  const onSync = (state: string) => {
    if (stopped) return;
    if (state === "SYNCING" || state === "PREPARED") {
      void flushMatrixSyncStore(syncDatabase, syncStore);
      if (readiness.canPublishAuthoritativeProjection) {
        void protocol?.retryPending();
      }
    }
    const update = readiness.statusForMatrixSync(state);
    if (update) handlers.onStatus(update.status, update.detail);
  };

  const replayKnownTimeline = async (): Promise<void> => {
    const currentRoom = room;
    if (!currentRoom || !protocol) return;
    for (const event of currentRoom.getLiveTimeline().getEvents()) enqueue(event);
    await replayThreadDirectory();
    await inboundChain;
  };

  const replayThreadDirectory = async (): Promise<void> => {
    let from: string | null = null;
    const seenTokens = new Set<string>();
    for (let pageIndex = 0; pageIndex < 1_000; pageIndex += 1) {
      const page = await client.createThreadListMessagesRequest(
        config.roomId,
        from,
        100,
        sdk.Direction.Backward,
        sdk.ThreadFilterType.All,
      );
      for (const rawEvent of page.chunk) {
        const raw = { ...rawEvent, room_id: rawEvent.room_id ?? config.roomId };
        await ingestEvent(new sdk.MatrixEvent(raw));
        const latest = latestThreadEvent(rawEvent);
        if (latest) {
          await ingestEvent(new sdk.MatrixEvent({
            ...latest,
            room_id: typeof latest.room_id === "string"
              ? latest.room_id
              : config.roomId,
          }));
        }
      }
      const next = typeof page.end === "string" && page.end ? page.end : null;
      if (!next) return;
      if (seenTokens.has(next)) {
        throw new Error("The Matrix thread directory repeated a pagination token.");
      }
      seenTokens.add(next);
      from = next;
    }
    throw new Error("The Matrix thread directory exceeded the 100,000-session safety limit.");
  };

  const recoverAuthoritativeState = async (): Promise<void> => {
    const operation = recoveryChain.catch(() => undefined).then(async () => {
      readiness.beginRecovery();
      handlers.onStatus("connecting", "matrix_gateway_state_syncing");
      if (!authoritativeProjectionPrepared) {
        const active = protocol;
        if (!active) throw new Error("The CVP/3 project is not initialized.");
        await active.prepareAuthoritativeRecovery();
        authoritativeProjectionPrepared = true;
      }
      const [workspaceRecovered, projectRecovered] = await Promise.all([
        recoverCurrentWorkspaceSnapshot(),
        recoverCurrentProjectSnapshot(),
      ]);
      if (!workspaceRecovered || !projectRecovered) {
        const missing = [
          !workspaceRecovered ? "workspace" : null,
          !projectRecovered ? "project" : null,
        ].filter((value): value is string => value !== null).join(" and ");
        throw new Error(`The Gateway has not published the current ${missing} snapshot pointer.`);
      }
      await replayKnownTimeline();
      await protocol?.retryPending();
      readiness.completeRecovery();
      publishProjection();
      handlers.onStatus("connected");
      completeReady();
    });
    recoveryChain = operation;
    await operation;
  };

  const reportRecoveryFailure = (context: string, error: unknown): void => {
    console.error(`[cvp3/matrix] ${context}`, error);
    if (error instanceof MatrixCvp3ReadModelRepairError) {
      readiness.failRecovery(error.code);
      handlers.onStatus("error", error.code);
      return;
    }
    const detail = "matrix_gateway_state_recovery_failed";
    readiness.failRecovery(detail);
    handlers.onStatus("error", detail);
  };

  const transportReady = (async () => {
    await withMatrixTimeout(syncStore.startup(), LOCAL_TIMEOUT_MS, "The Matrix sync store did not open in time.");
    handlers.onStatus("connecting", "Opening the Matrix encryption store…");
    await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: cryptoScope });
    const cryptoApi = client.getCrypto();
    if (!cryptoApi) throw new Error("Matrix encryption did not initialize.");
    const { AllDevicesIsolationMode } = await import("matrix-js-sdk/lib/crypto-api");
    cryptoApi.globalBlacklistUnverifiedDevices = true;
    cryptoApi.setDeviceIsolationMode(new AllDevicesIsolationMode(false));
    matrixDeviceKeys = await cryptoApi.getOwnDeviceKeys();
    if (!matrixDeviceKeys) throw new Error("Matrix device keys are unavailable.");
    client.on(sdk.ClientEvent.Sync, onSync);
    client.on(sdk.ClientEvent.Event, onMatrixEvent);
    await client.startClient({ initialSyncLimit: INITIAL_SYNC_LIMIT });
    await waitForInitialSync(client, sdk.ClientEvent.Sync);
    room = client.getRoom(config.roomId);
    if (!room) throw new Error("The bound Matrix project room is unavailable.");
    if (!client.isRoomEncrypted(config.roomId)) throw new Error("The Matrix project room is not encrypted.");
    room.on(sdk.RoomStateEvent.Events, onRoomState);
    if (trust) await verifyAndPinGatewayDevice(client, trust.gatewayTransport);
  })();

  const initialRecovery = transportReady.then(async () => {
    if (!trust) {
      handlers.onStatus("connected");
      completeReady();
      return;
    }
    if (!(await openAuthoritativeProjectGrant())) {
      readiness.failRecovery(MATRIX_PROJECT_AUTHORIZATION_REPAIR_REQUIRED);
      handlers.onStatus("error", MATRIX_PROJECT_AUTHORIZATION_REPAIR_REQUIRED);
      return;
    }
    await recoverAuthoritativeState();
  });
  void initialRecovery.catch(error => {
    reportRecoveryFailure("The current CVP/3 state could not be recovered", error);
    failReady(error);
  });

  const waitForGrant = async (signal?: AbortSignal): Promise<void> => {
    const deadline = Date.now() + 30_000;
    let nextAuthoritativeCheckAt = 0;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new DOMException("Pairing was cancelled.", "AbortError");
      if (await scanGrantState()) return;
      if (Date.now() >= nextAuthoritativeCheckAt) {
        if (await openAuthoritativeProjectGrant()) return;
        nextAuthoritativeCheckAt = Date.now() + 1_000;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(
      "The computer approved this device, but its conversation authorization did not arrive. Create a new one-time invitation on the computer and add this device again.",
    );
  };

  const pair = async (
    preview: PairingPreview,
    deviceName: string,
    signal?: AbortSignal,
  ): Promise<TrustedGateway> => {
    // Finish the bounded startup authorization check before rotating trust.
    // This prevents a late stale-grant result from overwriting a successful
    // reauthorization performed by this same connection.
    await initialRecovery;
    if (!matrixDeviceKeys) throw new Error("Matrix device keys are unavailable.");
    await waitForOwnMatrixDeviceKeys(config, matrixDeviceKeys, 30_000);
    await verifyAndPinGatewayDevice(client, preview.transport);
    const paired = await completePairing(
      preview,
      identity,
      {
        homeserver: config.homeserver,
        roomId: config.roomId,
        userId: config.userId,
        deviceId: config.matrixDeviceId,
        ed25519: matrixDeviceKeys.ed25519,
      },
      deviceName,
      createMatrixPairingTransport(
        client,
        sdk.RoomEvent.Timeline,
        sdk.MsgType.Notice,
        config.roomId,
        detail => handlers.onStatus("securing", detail),
      ),
      signal,
    );
    trust = paired;
    handlers.onTrustUpdated?.(paired);
    readiness.beginRecovery();
    handlers.onStatus("connecting", "matrix_gateway_state_syncing");
    try {
      await waitForGrant(signal);
      await recoverAuthoritativeState();
    } catch (error) {
      reportRecoveryFailure("The paired Gateway state could not be recovered", error);
      throw error;
    }
    return paired;
  };

  const loadHistory = async (sessionId: string, limit = 30): Promise<MatrixHistoryPage> => {
    await ready;
    const active = protocol;
    if (!active) throw new Error("The CVP/3 project is not initialized.");
    const session = active.projection.sessions.get(sessionId);
    if (!session?.threadRootEventId) return { messages: [], hasMore: false };
    const pageLimit = Math.max(1, Math.min(limit, 100));
    const from = historyInitialized.has(sessionId) ? historyTokens.get(sessionId) ?? undefined : undefined;
    const page = await client.relations(
      config.roomId,
      session.threadRootEventId,
      sdk.RelationType.Thread,
      null,
      {
        dir: sdk.Direction.Backward,
        limit: Math.min(32, pageLimit),
        recurse: true,
        ...(from ? { from } : {}),
      },
    );
    historyInitialized.add(sessionId);
    historyTokens.set(sessionId, page.nextBatch ?? null);
    for (const event of [page.originalEvent, ...page.events]) {
      if (event) await ingestEvent(event);
    }
    const delivered = deliveredHistory.get(sessionId) ?? new Set<string>();
    deliveredHistory.set(sessionId, delivered);
    const messages = active.projection.sessionMessages(sessionId)
      .filter(message =>
        !delivered.has(message.logicalId) && !delivered.has(message.physicalEventId)
      )
      .slice(-pageLimit)
      .map(message => {
        delivered.add(message.logicalId);
        delivered.add(message.physicalEventId);
        return toIncomingMessage(message);
      });
    return { messages, hasMore: Boolean(page.nextBatch) };
  };

  const loadLocalHistory = async (sessionId: string): Promise<MatrixHistoryPage> => {
    await ready;
    const active = protocol;
    if (!active) throw new Error("The CVP/3 project is not initialized.");
    const delivered = deliveredHistory.get(sessionId) ?? new Set<string>();
    deliveredHistory.set(sessionId, delivered);
    const available = active.projection.sessionMessages(sessionId)
      .filter(message =>
        !delivered.has(message.logicalId) && !delivered.has(message.physicalEventId)
      );
    const messages = available.slice(-1_000)
      .map(message => {
        delivered.add(message.logicalId);
        delivered.add(message.physicalEventId);
        return toIncomingMessage(message);
      });
    return {
      messages,
      hasMore: available.length > messages.length,
    };
  };

  const uploadAttachment = async (file: File): Promise<CodeverAttachment> => {
    await ready;
    if (file.size > MAX_CODEVER_ATTACHMENT_BYTES) throw new Error("Attachment is too large.");
    const plaintext = new Uint8Array(await file.arrayBuffer());
    const encrypted = await encryptMedia(plaintext);
    const uploaded = await client.uploadContent(
      new Blob([toArrayBuffer(encrypted.ciphertext)], { type: "application/octet-stream" }),
      { type: "application/octet-stream", includeFilename: false },
    );
    return attachmentSchema.parse({
      id: crypto.randomUUID(),
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: plaintext.byteLength,
      sha256: await sha256(plaintext),
      media: { url: uploaded.content_uri, ...encrypted.descriptor },
    });
  };

  const downloadAttachment = async (input: CodeverAttachment): Promise<Blob> => {
    await ready;
    const attachment = attachmentSchema.parse(input);
    const url = client.mxcUrlToHttp(attachment.media.url, undefined, undefined, undefined, false, false, true);
    if (!url) throw new Error("Matrix media URL is invalid.");
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${client.getAccessToken()}` },
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Matrix media download failed with HTTP ${response.status}.`);
    const ciphertext = new Uint8Array(await response.arrayBuffer());
    if (ciphertext.byteLength > attachment.media.size) throw new Error("Encrypted attachment exceeds its signed size.");
    const plaintext = await decryptMedia(ciphertext, attachment.media);
    if (plaintext.byteLength !== attachment.size || await sha256(plaintext) !== attachment.sha256) {
      throw new Error("Attachment integrity verification failed.");
    }
    return new Blob([toArrayBuffer(plaintext)], { type: attachment.mimeType });
  };

  return {
    ready,
    identity,
    get matrixDeviceKeys() {
      if (!matrixDeviceKeys) throw new Error("Matrix device keys are not ready.");
      return matrixDeviceKeys;
    },
    get deviceTransport() {
      if (!matrixDeviceKeys) throw new Error("Matrix device keys are not ready.");
      return {
        homeserver: config.homeserver,
        roomId: config.roomId,
        userId: config.userId,
        deviceId: config.matrixDeviceId,
        ed25519: matrixDeviceKeys.ed25519,
      };
    },
    pair,
    async send(payload) {
      await ready;
      if (!protocol) throw new Error("The CVP/3 project is not initialized.");
      const sent = await protocol.send(payload);
      return {
        eventId: sent.eventId ?? `$codever.queued.${sent.commandId}`,
        commandId: sent.commandId,
        sequence: 1,
        revision: 0,
        completion: sent.completion.then(toLegacyCompletion),
      };
    },
    async updateProjectExtensions(extensions) {
      await ready;
      if (!protocol) throw new Error("The Codever v3 project is not initialized.");
      const sent = await protocol.updateProjectExtensions(extensions);
      return {
        eventId: sent.eventId ?? `$codever.queued.${sent.commandId}`,
        commandId: sent.commandId,
        sequence: 1,
        revision: 0,
        completion: sent.completion.then(toLegacyCompletion),
      };
    },
    async updateWebPushSubscription(subscription) {
      await ready;
      if (!protocol) throw new Error("The Codever v3 project is not initialized.");
      const sent = await protocol.updateWebPushSubscription(subscription);
      return {
        eventId: sent.eventId ?? `$codever.queued.${sent.commandId}`,
        commandId: sent.commandId,
        sequence: 1,
        revision: 0,
        completion: sent.completion.then(toLegacyCompletion),
      };
    },
    async recoverCommand(commandId) {
      await ready;
      if (!protocol) throw new Error("The CVP/3 project is not initialized.");
      const sent = await protocol.recover(commandId);
      return {
        eventId: sent.eventId ?? `$codever.queued.${sent.commandId}`,
        commandId: sent.commandId,
        sequence: 1,
        revision: 0,
        completion: sent.completion.then(toLegacyCompletion),
      };
    },
    uploadAttachment,
    downloadAttachment,
    confirmRevisionRetry() {
      throw new Error("CVP/3 has no global revision conflict to retry.");
    },
    discardRevisionConflict: async () => undefined,
    markHistoryLoaded(sessionId, eventIds) {
      const delivered = deliveredHistory.get(sessionId) ?? new Set<string>();
      deliveredHistory.set(sessionId, delivered);
      for (const eventId of eventIds) delivered.add(eventId);
    },
    loadLocalHistory,
    loadHistoryPage: loadHistory,
    async observeCommandCompletion(commandId, timeoutMs) {
      if (!protocol) throw new Error("The CVP/3 project is not initialized.");
      return toLegacyCompletion(await protocol.observeCompletion(commandId, timeoutMs));
    },
    releaseCommand: async () => undefined,
    stop() {
      if (stopped) return;
      stopped = true;
      client.off(sdk.ClientEvent.Event, onMatrixEvent);
      room?.off(sdk.RoomStateEvent.Events, onRoomState);
      client.off(sdk.ClientEvent.Sync, onSync);
      client.stopClient();
      handlers.onStatus("offline");
      void flushAndReleaseMatrixSyncStore(syncDatabase, syncStore, cryptoLock);
    },
  };
}

async function sendMatrixCvp3ApplicationEvent(
  client: MatrixClient,
  roomId: string,
  content: RoomMessageEventContent,
  transactionId: string,
): Promise<string> {
  const path = [
    "/rooms/",
    encodeURIComponent(roomId),
    "/send/m.room.message/",
    encodeURIComponent(transactionId),
  ].join("");
  const response = await client.http.authedRequest<{ event_id: string }>(
    "PUT" as Parameters<MatrixClient["http"]["authedRequest"]>[0],
    path,
    undefined,
    content,
  );
  return response.event_id;
}

export function toIncomingMessage(
  message: import("./matrixCvp3Projection").V3ProjectedMessage,
  replacesEventId?: string,
): IncomingCodeverMessage {
  const payload = message.payload;
  const toolGroup = toolGroupFromCvp3Payload(payload, message.timestamp);
  return {
    // Logical CVP identity is the cross-client/UI identity. Matrix event IDs
    // change whenever a streamed message version is emitted and are transport
    // metadata only. The replacement alias migrates caches written by older
    // browser builds that incorrectly keyed bubbles by physical event ID.
    eventId: message.logicalId,
    sender: message.sender === "user" ? "device" : "gateway",
    timestamp: message.timestamp,
    encrypted: true,
    kind: payload?.type === "decision.requested" || payload?.type === "extension.interaction.requested"
      ? "permission"
      : payload?.type === "turn.failed"
        ? "error"
        : message.sender === "user"
          ? "user"
          : toolGroup
            ? "tool"
            : "agent",
    text: message.body,
    sessionId: message.sessionId,
    ...(message.commandId ? { commandId: message.commandId } : {}),
    ...(message.originDeviceId ? { originDeviceId: message.originDeviceId } : {}),
    ...(payload?.type === "decision.requested" || payload?.type === "extension.interaction.requested"
      ? { requestId: payload.requestId }
      : {}),
    ...(replacesEventId || message.physicalEventId
      ? { replacesEventId: replacesEventId || message.physicalEventId }
      : {}),
    format: message.format,
    ...(payload?.type === "assistant.message" && payload.attachments
      ? { attachments: payload.attachments }
      : {}),
    ...(toolGroup ? { toolGroup } : {}),
    raw: payload
      ? {
          ...structuredClone(payload) as Record<string, unknown>,
          ...(message.resolvedActionId
            ? { resolvedActionId: message.resolvedActionId }
            : {}),
        }
      : {},
  };
}

function toolGroupFromCvp3Payload(
  payload: import("@codever/protocol").Cvp3Event["payload"] | undefined,
  timestamp: number,
): ToolGroupPresentation | undefined {
  if (payload?.type === "assistant.message") {
    return parseToolGroupPresentation(payload.ui);
  }
  if (payload?.type !== "tool.activity") return undefined;
  return {
    kind: "tool_group",
    version: 1,
    groupId: payload.toolCallId,
    tools: [{
      id: payload.toolCallId,
      name: payload.name,
      title: payload.name,
      category: "unknown",
      phase: payload.phase,
      isError: payload.phase === "failed",
      startedAt: timestamp,
      updatedAt: timestamp,
    }],
  };
}

function toLegacyCompletion(
  completion: import("./matrixCvp3Projection").Cvp3CommandCompletion,
): CommandCompletion {
  const payload = completion.event.payload;
  return {
    commandId: completion.commandId,
    sequence: 1,
    revision: 0,
    outcome: completion.outcome === "succeeded" ? "succeeded" : "failed",
    ...(completion.sessionId ? { sessionId: completion.sessionId } : {}),
    ...(payload.type === "device.invitation.created"
      ? { result: { pairingLink: payload.pairingLink, expiresAt: payload.expiresAt } }
      : payload.type === "provider.sessions.listed" || payload.type === "provider.session.inspected"
        ? { result: payload }
      : {}),
    ...(payload.type === "turn.failed"
      ? { error: { code: payload.code, message: payload.message, retryable: false } }
      : payload.type === "command.rejected"
        ? { error: { code: payload.code, message: payload.message, retryable: payload.retryable } }
        : {}),
  };
}

function gatewayState(
  protocol: MatrixCvp3ProtocolClient,
  config: MatrixConnectionConfig,
  trust: TrustedGateway | null,
): GatewayStateSnapshot {
  const project = protocol.projection.project;
  const sessions = protocol.projection.visibleSessions();
  const inboxFiles = protocol.projection.visibleInboxFiles();
  return {
    stateVersion: Math.max(1, ...sessions.map(session => session.stateVersion)),
    revision: 0,
    revisionEpoch: "matrix-native-v3",
    revisionEpochGeneration: 1,
    activeDeviceCount: trust?.activeDeviceCount ?? 1,
    updatedAt: Math.max(
      0,
      ...sessions.map(session => session.updatedAt),
      ...inboxFiles.map(file => file.receivedAt),
    ),
    currentSessionId: null,
    sessions: sessions.map(session => ({
      id: session.sessionId,
      title: session.title,
      updatedAt: session.updatedAt,
      status: session.lifecycle === "archived"
        ? "archived"
        : session.activity === "working" || session.activity === "queued"
          ? "running"
          : session.activity === "failed"
            ? "failed"
            : "idle",
      activityPhase: session.activity === "working"
        ? "working"
        : session.activity === "queued"
          ? "starting"
          : session.activity === "failed"
            ? "failed"
            : "idle",
      scope: session.scope ?? "project",
      projectId: session.projectId,
      projectName: session.scope === "scratch" ? "Temporary" : project?.name ?? "Project",
      cwd: session.cwd ?? project?.cwd ?? "",
      provider: session.provider ?? project?.provider ?? "unknown",
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(session.activeTurnId ? { activeTurnId: session.activeTurnId } : {}),
      extensions: session.extensions ?? [],
      availableCommands: session.availableCommands ?? [],
    })),
    inboxFiles: inboxFiles.map(file => ({
      id: file.fileId,
      receivedAt: file.receivedAt,
      ...(file.caption ? { caption: file.caption } : {}),
      ...(file.sourceLabel ? { sourceLabel: file.sourceLabel } : {}),
      attachment: file.attachment,
    })),
    workspace: {
      projectId: project?.projectId ?? "unknown",
      projectName: project?.name ?? "Project",
      cwd: project?.cwd ?? "",
      provider: project?.provider ?? "unknown",
      ...(project?.model ? { model: project.model } : {}),
      ...(project?.reasoningEffort ? { reasoningEffort: project.reasoningEffort } : {}),
      permissionMode: project?.permissionMode ?? "default",
      defaultExtensions: project?.defaultExtensions ?? [],
      extensionDefaultsRevision: project?.extensionDefaultsRevision ?? 1,
    },
    capabilities: protocol.projection.workspace
      ? parseGatewayCapabilities(protocol.projection.workspace.capabilities)
      : {
          models: [],
          providers: [],
          permissionModes: [{ id: "default", name: "Default" }],
          canCreateSession: true,
          canSelectSession: false,
          canArchiveSession: true,
          canDeleteSession: false,
          sessionExtensions: project?.installedExtensions ?? [],
        },
    nativeClientReleases: protocol.projection.workspace?.clientReleases ?? [],
  };
}

function isMatrixNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    errcode?: unknown;
    httpStatus?: unknown;
    status?: unknown;
  };
  return (
    candidate.errcode === "M_NOT_FOUND"
    || candidate.httpStatus === 404
    || candidate.status === 404
  );
}

function latestThreadEvent(input: unknown): Record<string, unknown> | null {
  const unsigned = asRecord(asRecord(input)?.unsigned);
  const relations = asRecord(unsigned?.["m.relations"]);
  const thread = asRecord(relations?.["m.thread"]);
  return asRecord(thread?.latest_event);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
