import type {
  CodeverCommand,
  CommandPayload,
  JsonValue,
  SignedCommand,
} from "@codever/protocol";
import {
  generateDeviceKeyPair,
  openSecureEnvelope,
  sealSecureEnvelope,
  SecurityError,
  signCommand,
  type ReplayStore,
  verifyGatewayDeviceRotation,
  verifyPairingResponse,
} from "@codever/security";
import type {
  Device,
  MatrixClient,
  MatrixEvent,
  MsgType,
  Room,
} from "matrix-js-sdk";
import {
  completePairing,
  loadTrustedGateway,
  saveTrustedGateway,
  type PairingPreview,
  type PairingTransport,
  type TrustedGateway,
} from "./pairing";
import {
  signedGatewayDeviceRotationSchema,
  jsonValueSchema,
  signedSecureEnvelopeSchema,
  type MatrixTransportBinding,
  type SignedPairingOffer,
  type SignedPairingRequest,
  type SignedPairingResponse,
} from "@codever/protocol";
import { IndexedDbReplayStore } from "./IndexedDbReplayStore";
import {
  CommandLifecycle,
  type CommandCompletion,
} from "./commandLifecycle";
import {
  acquireMatrixCryptoLock,
  checkpointAndReleaseMatrixSyncStore,
  checkpointMatrixSyncStore,
  destroyAndReleaseMatrixSyncStore,
  matrixCryptoLockName,
  matrixSyncDatabaseName,
  waitForMatrixSyncStoreClose,
} from "./matrixSyncStore";
import {
  canMigrateLegacyGatewayState,
  classifyGatewayStateEpoch,
  createGatewayStateCacheRecord,
  parseGatewayStateCacheRecord,
  parseGatewayStateExtension,
  type GatewayStateCacheBinding,
  type GatewayStateSnapshot,
} from "./gatewayState";
export {
  parseGatewayStateExtension,
  type GatewayCapabilities,
  type GatewayCapabilityOption,
  type GatewaySessionSummary,
  type GatewayStateSnapshot,
  type GatewayWorkspaceState,
  canMigrateLegacyGatewayState,
  classifyGatewayStateEpoch,
} from "./gatewayState";

export const MATRIX_CONFIG_STORAGE_KEY = "codever.matrix.connection.v1";
const DEVICE_DATABASE = "codever-pwa-identity";
const DEVICE_STORE = "keys";
const DEVICE_KEY = "p256-v1";
const COMMAND_SEQUENCE_STORE = "command-sequences";
const COMMAND_TTL_MS = 2 * 60_000;
const INCOMPLETE_OUTBOX_LEASE_MS = 30_000;

export type MatrixConnectionConfig = {
  homeserver: string;
  userId: string;
  accessToken: string;
  matrixDeviceId: string;
  roomId: string;
  gatewayId: string;
  conversationId: string;
  gatewayMatrixUserId: string;
  gatewayMatrixDeviceId: string;
  gatewayMatrixEd25519: string;
};

export type DeviceIdentity = {
  keyId: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JsonWebKey;
};

type CommandReservation = {
  commandId: string;
  sequence: number;
  baseRevision: number;
  revisionEpoch: string;
};

type PendingOutboundCommand = CommandReservation & {
  createdAt: number;
  payload: CommandPayload;
  plaintext?: Record<string, unknown>;
};

type CommandSequenceState = {
  lastAcknowledged: number;
  lastRevision: number;
  revisionInitialized: boolean;
  revisionEpoch?: string;
  revisionEpochGeneration?: number;
  retiredRevisionEpochs: string[];
  stateVersion: number;
  pending?: PendingOutboundCommand;
};

type DurableGatewayEpochState = {
  revisionEpoch: string;
  revisionEpochGeneration: number;
  stateVersion: number;
  revision: number;
  retiredRevisionEpochs: string[];
};

export type IncomingCodeverMessage = {
  eventId: string;
  sender: string;
  timestamp: number;
  encrypted: boolean;
  kind: "agent" | "user" | "tool" | "permission" | "notice" | "error";
  text: string;
  sessionId?: string;
  historical?: boolean;
  commandId?: string;
  revision?: number;
  originDeviceId?: string;
  originDeviceName?: string;
  activeDeviceCount?: number;
  requestId?: string;
  streamId?: string;
  toolCallId?: string;
  toolStatus?: "running" | "succeeded" | "failed";
  replacesEventId?: string;
  raw: Record<string, unknown>;
};

export type MatrixConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "error";

export type CollaborationState = {
  activeDeviceCount?: number;
  revision?: number;
  gatewayState?: GatewayStateSnapshot;
};

export type CommandResultState = CommandCompletion;

export type CommandSendResult = {
  eventId: string;
  commandId: string;
  sequence: number;
  revision: number;
  completion: Promise<CommandCompletion>;
};

export type MatrixHistoryPage = {
  messages: IncomingCodeverMessage[];
  hasMore: boolean;
};

class RevisionConflictError extends Error {
  constructor(
    readonly commandId: string,
    readonly expectedRevision: number,
  ) {
    super("The room changed on another device; rebasing this command.");
    this.name = "RevisionConflictError";
  }
}

export class CommandRevisionConflictError extends Error {
  constructor(
    readonly commandId: string,
    readonly expectedRevision: number,
    readonly payload: CommandPayload,
  ) {
    super(
      "Another device updated this session. Review this action before sending it again.",
    );
    this.name = "CommandRevisionConflictError";
  }
}

/**
 * Historical envelopes are authenticated and decrypted for display only. They
 * deliberately do not consume or mutate the execution replay ledger; the
 * history decoder below never dispatches control callbacks.
 */
class DisplayOnlyReplayStore implements ReplayStore {
  async claimAll(): Promise<boolean> {
    return true;
  }

  async prune(): Promise<void> {
    // Display-only verification has no replay state to prune.
  }
}

export type MatrixConnection = {
  readonly identity: DeviceIdentity;
  readonly matrixDeviceKeys: {
    ed25519: string;
    curve25519: string;
  };
  readonly deviceTransport: MatrixTransportBinding;
  readonly client: MatrixClient;
  pair(
    preview: PairingPreview,
    deviceName: string,
    signal?: AbortSignal,
  ): Promise<TrustedGateway>;
  send(payload: CommandPayload): Promise<CommandSendResult>;
  confirmRevisionRetry(commandId: string): Promise<CommandSendResult>;
  discardRevisionConflict(commandId: string): Promise<void>;
  markHistoryLoaded(sessionId: string, eventIds: readonly string[]): void;
  loadRecentHistory(
    sessionId: string,
    limit?: number,
  ): Promise<MatrixHistoryPage>;
  loadHistoryPage(sessionId: string, limit?: number): Promise<MatrixHistoryPage>;
  stop(): void;
};

export function normalizeMatrixConfig(
  input: MatrixConnectionConfig,
): MatrixConnectionConfig {
  const homeserver = normalizeHomeserver(input.homeserver);
  const config = {
    homeserver,
    userId: input.userId.trim(),
    accessToken: input.accessToken.trim(),
    matrixDeviceId: input.matrixDeviceId.trim(),
    roomId: input.roomId.trim(),
    gatewayId: input.gatewayId.trim(),
    conversationId: input.conversationId.trim() || input.roomId.trim(),
    gatewayMatrixUserId: input.gatewayMatrixUserId?.trim() ?? "",
    gatewayMatrixDeviceId: input.gatewayMatrixDeviceId?.trim() ?? "",
    gatewayMatrixEd25519: input.gatewayMatrixEd25519?.trim() ?? "",
  };
  const requiredFields: Array<keyof MatrixConnectionConfig> = [
    "homeserver",
    "userId",
    "accessToken",
    "matrixDeviceId",
    "roomId",
    "gatewayId",
    "conversationId",
  ];
  const missing = requiredFields.find((field) => !config[field]);
  if (missing) {
    throw new Error(`${humanizeField(missing)} is required.`);
  }
  if (!config.userId.startsWith("@")) {
    throw new Error("Matrix user ID must start with @.");
  }
  if (!config.roomId.startsWith("!")) {
    throw new Error("Encrypted room ID must start with !.");
  }
  gatewayPin(config);
  return config;
}

export function normalizeHomeserver(value: string): string {
  const homeserver = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(homeserver);
  } catch {
    throw new Error("Homeserver must be a valid http(s) URL.");
  }
  const isLocal =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new Error("Use HTTPS for remote homeservers.");
  }
  return homeserver;
}

export async function resolveMatrixSession(
  input: MatrixConnectionConfig,
): Promise<MatrixConnectionConfig> {
  // Validate the QR-provided endpoint before attaching any bearer credential.
  const homeserver = normalizeHomeserver(input.homeserver);
  const accessToken = input.accessToken.trim();
  if (!homeserver) throw new Error("Homeserver is required.");
  if (!accessToken) throw new Error("Access token is required.");

  const response = await fetch(
    `${homeserver}/_matrix/client/v3/account/whoami`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  if (!response.ok) {
    throw new Error("Matrix sign-in was not accepted. Check the access token.");
  }
  const session = asRecord(await response.json());
  const userId = typeof session?.user_id === "string" ? session.user_id : "";
  const matrixDeviceId =
    typeof session?.device_id === "string" ? session.device_id : "";
  if (!userId || !matrixDeviceId) {
    throw new Error("Matrix did not identify this signed-in device.");
  }
  if (input.userId.trim() && input.userId.trim() !== userId) {
    throw new Error("The access token belongs to a different Matrix account.");
  }
  return {
    ...input,
    homeserver,
    accessToken,
    userId,
    matrixDeviceId,
  };
}

export function saveMatrixConfig(config: MatrixConnectionConfig): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(
    MATRIX_CONFIG_STORAGE_KEY,
    JSON.stringify(normalizeMatrixConfig(config)),
  );
}

export function loadMatrixConfig(): MatrixConnectionConfig | null {
  if (typeof localStorage === "undefined") return null;
  const stored = localStorage.getItem(MATRIX_CONFIG_STORAGE_KEY);
  if (!stored) return null;
  try {
    return normalizeMatrixConfig(JSON.parse(stored) as MatrixConnectionConfig);
  } catch {
    return null;
  }
}

export function clearMatrixConfig(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(MATRIX_CONFIG_STORAGE_KEY);
}

export async function getOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  const database = await openIdentityDatabase();
  try {
    const existing = await readIdentity(database);
    if (existing) return existing;
    const generated = await generateDeviceKeyPair();
    const identity: DeviceIdentity = {
      keyId: generated.keyId,
      privateKey: generated.privateKey,
      publicKey: generated.publicKey,
      publicJwk: generated.publicJwk,
    };
    await writeIdentity(database, identity);
    return identity;
  } finally {
    database.close();
  }
}

async function createSignedCommand(
  configInput: MatrixConnectionConfig,
  identity: DeviceIdentity,
  payload: CommandPayload,
  now: number,
  reservation: CommandReservation,
  sequenceEpoch: string,
): Promise<SignedCommand> {
  const config = normalizeMatrixConfig(configInput);
  const command: CodeverCommand = {
    kind: "codever.command",
    version: 1,
    commandId: reservation.commandId,
    gatewayId: config.gatewayId,
    // Codever authorization follows the persistent P-256 application key.
    // The Matrix device ID is transport metadata and may rotate independently.
    deviceId: identity.keyId,
    conversationId: config.conversationId,
    sequenceEpoch,
    sequence: reservation.sequence,
    baseRevision: reservation.baseRevision,
    revisionEpoch: reservation.revisionEpoch,
    operation: payload.operation,
    issuedAt: now,
    expiresAt: now + COMMAND_TTL_MS,
    nonce: randomNonce(),
    payload,
  };
  return signCommand(command, identity.privateKey, identity.keyId);
}

export async function connectMatrix(
  configInput: MatrixConnectionConfig,
  handlers: {
    onMessage(message: IncomingCodeverMessage): void;
    onStatus(status: MatrixConnectionStatus, detail?: string): void;
    onTrustUpdated?(trust: TrustedGateway): void;
    onCollaborationState?(state: CollaborationState): void;
    onCommandResult?(result: CommandResultState): void;
  },
): Promise<MatrixConnection> {
  const config = normalizeMatrixConfig(configInput);
  const identity = await getOrCreateDeviceIdentity();
  let activeTrust = await loadTrustedGateway(identity);
  const replayStore = new IndexedDbReplayStore();
  const historyReplayStore = new DisplayOnlyReplayStore();
  const sdk = await import("matrix-js-sdk");
  const syncStoreDatabaseName = await matrixSyncDatabaseName(config);
  await waitForMatrixSyncStoreClose(syncStoreDatabaseName);
  const syncStore = new sdk.IndexedDBStore({
    indexedDB: window.indexedDB,
    dbName: syncStoreDatabaseName,
  });
  const client = sdk.createClient({
    baseUrl: config.homeserver,
    userId: config.userId,
    accessToken: config.accessToken,
    deviceId: config.matrixDeviceId,
    timelineSupport: true,
    store: syncStore,
  });
  const cryptoStoreScope = await matrixCryptoLockName(config);
  const cryptoLock = await acquireMatrixCryptoLock(cryptoStoreScope);

  let stopped = false;
  let initialSyncComplete = false;
  let persistenceFailure: string | null = null;
  const failPersistence = (detail: string) => {
    if (persistenceFailure) return;
    persistenceFailure = detail;
    handlers.onStatus(
      "error",
      `${detail} Log in as a new Matrix device and pair this browser again.`,
    );
  };
  const assertPersistenceHealthy = () => {
    if (persistenceFailure) {
      throw new Error(
        `${persistenceFailure} Sending is locked until this browser is rebuilt as a new Matrix device and paired again.`,
      );
    }
  };
  syncStore.on("degraded", (error: Error) => {
    if (!stopped) {
      failPersistence(
        `Matrix sync persistence degraded to memory: ${formatError(error)}.`,
      );
    }
  });
  syncStore.on("closed", () => {
    if (!stopped) {
      failPersistence(
        "Matrix sync persistence closed unexpectedly; device-list freshness can no longer be trusted.",
      );
    }
  });
  let matrixDeviceKeys: { ed25519: string; curve25519: string } | null = null;
  const seen = new Set<string>();
  const commandLifecycle = new CommandLifecycle();
  const revisionConflicts = new Map<string, number>();
  const historySeen = new Set<string>();
  const historyBySession = new Map<string, IncomingCodeverMessage[]>();
  const deliveredHistory = new Map<string, Set<string>>();
  let legacyHistorySessionHint: string | null = null;
  let historyInitialized = false;
  let historyChain: Promise<unknown> = Promise.resolve();
  const onCommandAcknowledged = async (
    commandId: string,
    sequence: number,
    revision: number,
    revisionEpoch: string,
    activeDeviceCount?: number,
  ): Promise<void> => {
    const trust = activeTrust;
    if (!trust) return;
    await acknowledgePendingCommand(
      config,
      identity,
      trust.certificate.certificate.certificateId,
      { commandId, sequence, baseRevision: revision, revisionEpoch },
      revision,
      revisionEpoch,
    );
    commandLifecycle.recordAcknowledgement(commandId, sequence, revision);
    handlers.onCollaborationState?.({
      revision,
      ...(activeDeviceCount !== undefined ? { activeDeviceCount } : {}),
    });
  };
  const onRevisionConflict = async (
    commandId: string,
    expectedRevision: number,
    revisionEpoch: string,
    activeDeviceCount?: number,
  ): Promise<void> => {
    const trust = activeTrust;
    if (!trust) return;
    await recordKnownRevision(
      config,
      identity,
      trust.certificate.certificate.certificateId,
      expectedRevision,
      revisionEpoch,
    );
    revisionConflicts.set(commandId, expectedRevision);
    handlers.onCollaborationState?.({
      revision: expectedRevision,
      ...(activeDeviceCount !== undefined ? { activeDeviceCount } : {}),
    });
    if (
      commandLifecycle.rejectAcknowledgement(
        commandId,
        new RevisionConflictError(commandId, expectedRevision),
      )
    ) {
      revisionConflicts.delete(commandId);
    }
  };
  const onAuthenticatedCommandResult = async (
    result: CommandResultState,
    revisionEpoch: string,
    activeDeviceCount?: number,
  ): Promise<void> => {
    // Persist the implicit acknowledgement before waking either sender waiter.
    // This single IndexedDB transaction clears pending and advances both
    // device sequence and Gateway revision even if the explicit ack is lost.
    await onCommandAcknowledged(
      result.commandId,
      result.sequence,
      result.revision,
      revisionEpoch,
      activeDeviceCount,
    );
    commandLifecycle.recordResult(result);
    handlers.onCommandResult?.(result);
  };
  const onKnownRevision = async (
    revision: number,
    revisionEpoch: string,
    activeDeviceCount?: number,
  ): Promise<void> => {
    const trust = activeTrust;
    if (trust) {
      await recordKnownRevision(
        config,
        identity,
        trust.certificate.certificate.certificateId,
        revision,
        revisionEpoch,
      );
    }
    handlers.onCollaborationState?.({
      revision,
      ...(activeDeviceCount !== undefined ? { activeDeviceCount } : {}),
    });
  };
  const onGatewayState = async (
    gatewayState: GatewayStateSnapshot,
  ): Promise<void> => {
    const trust = activeTrust;
    if (!trust) return;
    const accepted = await initializeKnownRevision(
      config,
      identity,
      trust.certificate.certificate.certificateId,
      gatewayState,
    );
    if (!accepted) return;
    handlers.onCollaborationState?.({
      revision: gatewayState.revision,
      activeDeviceCount: gatewayState.activeDeviceCount,
      gatewayState,
    });
  };
  const onTimeline = (
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline: boolean | undefined,
  ) => {
    if (stopped || !room || room.roomId !== config.roomId || toStartOfTimeline) {
      return;
    }
    void forwardEvent(
      client,
      event,
      seen,
      config,
      handlers.onMessage,
      (trust) => {
        activeTrust = trust;
        handlers.onTrustUpdated?.(trust);
      },
      identity,
      () => activeTrust,
      replayStore,
      onCommandAcknowledged,
      onRevisionConflict,
      onKnownRevision,
      onAuthenticatedCommandResult,
      onGatewayState,
      !initialSyncComplete,
    ).catch((error) => {
      handlers.onStatus("error", formatError(error));
    });
  };
  const onSync = (state: string) => {
    if (stopped) return;
    if (persistenceFailure) {
      handlers.onStatus("error", persistenceFailure);
      return;
    }
    if (state === "SYNCING" || state === "PREPARED") {
      // Do not close this IndexedDB connection synchronously: MatrixClient
      // still finishes background stop work after stopClient() returns, and
      // closing here can make an immediate post-pairing reconnect degrade to
      // memory. The forced checkpoint is serialized before the next client
      // opens the same database; the stopped client no longer writes to it.
      void checkpointMatrixSyncStore(
        syncStoreDatabaseName,
        syncStore,
      ).catch((error) => {
        if (!stopped) {
          failPersistence(
            `Matrix sync state could not be checkpointed: ${formatError(error)}.`,
          );
        }
      });
      handlers.onStatus("connected");
    } else if (state === "RECONNECTING" || state === "CATCHUP") {
      handlers.onStatus("reconnecting");
    } else if (state === "ERROR") {
      handlers.onStatus("error", "Matrix sync failed. Check the token and server.");
    } else if (state === "STOPPED") {
      handlers.onStatus("offline");
    }
  };

  handlers.onStatus("connecting", "Opening the encrypted device store…");
  try {
    // SDK 41 assigns the store's user factory during createClient, so startup
    // must happen after createClient({ store }) and before the first /sync.
    await syncStore.startup();
    if (activeTrust && !(await syncStore.getSavedSyncToken())) {
      throw new Error(
        "This trusted browser has no persisted Matrix sync checkpoint, so its device list may be stale. Log in as a new Matrix device and pair this browser again.",
      );
    }
    assertPersistenceHealthy();
    await client.initRustCrypto({
      useIndexedDB: true,
      cryptoDatabasePrefix: cryptoStoreScope,
    });
    const cryptoApi = client.getCrypto();
    if (!cryptoApi) {
      throw new Error("Matrix Rust crypto did not initialize.");
    }
    const { AllDevicesIsolationMode } = await import(
      "matrix-js-sdk/lib/crypto-api"
    );
    cryptoApi.globalBlacklistUnverifiedDevices = true;
    cryptoApi.setDeviceIsolationMode(new AllDevicesIsolationMode(false));
    matrixDeviceKeys = await cryptoApi.getOwnDeviceKeys();
    if (!matrixDeviceKeys) {
      throw new Error("Matrix device keys were not initialized.");
    }
    client.on(sdk.RoomEvent.Timeline, onTimeline);
    client.on(sdk.ClientEvent.Sync, onSync);
    await client.startClient({ initialSyncLimit: 30 });
    await waitForInitialSync(client, sdk.ClientEvent.Sync);
    initialSyncComplete = true;

    const room = client.getRoom(config.roomId);
    if (!room) {
      throw new Error(
        "Room is not available to this account. Join it before connecting.",
      );
    }
    if (!client.isRoomEncrypted(config.roomId)) {
      throw new Error("Refusing to connect: the selected Matrix room is not encrypted.");
    }
    const configuredGateway = gatewayPin(config);
    if (configuredGateway) {
      await verifyAndPinGatewayDevice(client, configuredGateway);
      await cryptoApi.forceDiscardSession(config.roomId);
    }

    if (activeTrust) {
      const cachedGatewayState = await loadCachedGatewayState(
        config,
        identity,
        activeTrust.certificate.certificate.certificateId,
      );
      if (cachedGatewayState) {
        handlers.onCollaborationState?.({
          revision: cachedGatewayState.revision,
          activeDeviceCount: cachedGatewayState.activeDeviceCount,
          gatewayState: cachedGatewayState,
        });
      }
    }

    for (const event of room.getLiveTimeline().getEvents()) {
      await forwardEvent(
        client,
        event,
        seen,
        config,
        handlers.onMessage,
        (trust) => {
          activeTrust = trust;
          handlers.onTrustUpdated?.(trust);
        },
        identity,
        () => activeTrust,
        replayStore,
        onCommandAcknowledged,
        onRevisionConflict,
        onKnownRevision,
        onAuthenticatedCommandResult,
        onGatewayState,
        true,
      );
    }
    assertPersistenceHealthy();
    handlers.onStatus("connected");
  } catch (error) {
    stopped = true;
    client.off(sdk.RoomEvent.Timeline, onTimeline);
    client.off(sdk.ClientEvent.Sync, onSync);
    client.stopClient();
    await destroyAndReleaseMatrixSyncStore(
      syncStoreDatabaseName,
      syncStore,
      cryptoLock,
    );
    handlers.onStatus("error", formatError(error));
    throw error;
  }
  if (!matrixDeviceKeys) {
    await destroyAndReleaseMatrixSyncStore(
      syncStoreDatabaseName,
      syncStore,
      cryptoLock,
    );
    throw new Error("Matrix device keys were not initialized.");
  }
  const waitForCommandAcknowledgement = (
    reservation: CommandReservation,
    timeoutMs = 30_000,
  ): Promise<number> => {
    const conflict = revisionConflicts.get(reservation.commandId);
    if (conflict !== undefined) {
      revisionConflicts.delete(reservation.commandId);
      return Promise.reject(
        new RevisionConflictError(reservation.commandId, conflict),
      );
    }
    return commandLifecycle.waitForAcknowledgement(
      reservation.commandId,
      reservation.sequence,
      timeoutMs,
    );
  };
  let outboundChain: Promise<unknown> = Promise.resolve();
  let pendingRevisionConflict: {
    reservation: CommandReservation;
    payload: CommandPayload;
    sequenceEpoch: string;
    trust: TrustedGateway;
    expectedRevision: number;
  } | null = null;
  const holdRevisionConflict = (
    error: RevisionConflictError,
    reservation: CommandReservation,
    payload: CommandPayload,
    sequenceEpoch: string,
    trust: TrustedGateway,
  ): never => {
    pendingRevisionConflict = {
      reservation,
      payload: structuredClone(payload),
      sequenceEpoch,
      trust,
      expectedRevision: error.expectedRevision,
    };
    throw new CommandRevisionConflictError(
      error.commandId,
      error.expectedRevision,
      payload,
    );
  };
  const sendPayload = async (
    payload: CommandPayload,
  ): Promise<CommandSendResult> => {
    if (stopped) throw new Error("Matrix connection is closed.");
    assertPersistenceHealthy();
    const trust = activeTrust;
    if (!trust) {
      throw new Error(
        "Pair and verify the Gateway application key before sending.",
      );
    }
    if (!client.isRoomEncrypted(config.roomId)) {
      throw new Error("Refusing to send to an unencrypted Matrix room.");
    }
    if (pendingRevisionConflict) {
      throw new CommandRevisionConflictError(
        pendingRevisionConflict.reservation.commandId,
        pendingRevisionConflict.expectedRevision,
        pendingRevisionConflict.payload,
      );
    }
    const sequenceEpoch = trust.certificate.certificate.certificateId;
    await assertRevisionInitialized(
      config,
      identity,
      sequenceEpoch,
    );
    const recovered = await retryPendingCommand(
      client,
      config,
      identity,
      sequenceEpoch,
      trust,
    );
    if (recovered) {
      try {
        const revision = await waitForCommandAcknowledgement(
          recovered.reservation,
        );
        if (JSON.stringify(recovered.payload) === JSON.stringify(payload)) {
          return {
            eventId: recovered.eventId,
            commandId: recovered.reservation.commandId,
            sequence: recovered.reservation.sequence,
            revision,
            completion: commandLifecycle.waitForCompletion(
              recovered.reservation.commandId,
            ),
          };
        }
      } catch (error) {
        if (!(error instanceof RevisionConflictError)) throw error;
        holdRevisionConflict(
          error,
          recovered.reservation,
          recovered.payload,
          sequenceEpoch,
          trust,
        );
      }
    }

    const reservation = await reserveCommandSequence(
      config,
      identity,
      sequenceEpoch,
      payload,
    );
    return transmitOnce(reservation, payload, sequenceEpoch, trust);
  };
  const transmitOnce = async (
    reservation: CommandReservation,
    payload: CommandPayload,
    sequenceEpoch: string,
    trust: TrustedGateway,
  ): Promise<CommandSendResult> => {
    try {
      const eventId = await transmitReservation(
        reservation,
        payload,
        sequenceEpoch,
        trust,
      );
      const revision = await waitForCommandAcknowledgement(reservation);
      return {
        eventId,
        commandId: reservation.commandId,
        sequence: reservation.sequence,
        revision,
        completion: commandLifecycle.waitForCompletion(
          reservation.commandId,
        ),
      };
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error;
      return holdRevisionConflict(
        error,
        reservation,
        payload,
        sequenceEpoch,
        trust,
      );
    }
  };
  const transmitReservation = async (
    reservation: CommandReservation,
    payload: CommandPayload,
    sequenceEpoch: string,
    trust: TrustedGateway,
  ): Promise<string> => {
    assertPersistenceHealthy();
    let content: Record<string, unknown>;
    try {
      const envelope = await createSignedCommand(
        config,
        identity,
        payload,
        Date.now(),
        reservation,
        sequenceEpoch,
      );
      const certificate = trust.certificate.certificate;
      const plaintext = {
        msgtype: sdk.MsgType.Text,
        body: fallbackBody(payload),
        "io.codever": {
          version: 1,
          kind: "signed_command",
          signed_command: envelope,
        },
      } as const;
      await savePendingCommandPlaintext(
        config,
        identity,
        sequenceEpoch,
        reservation.commandId,
        plaintext,
      );
      const secureEnvelope = await sealSecureEnvelope({
        plaintext,
        senderPrivateKey: identity.privateKey,
        recipientPublicKey: trust.gatewayKey.publicKey,
        gatewayId: trust.gatewayId,
        conversationId: config.conversationId,
        direction: "device_to_gateway",
        senderDeviceId: certificate.deviceId,
        recipientDeviceId: certificate.gatewayId,
        senderKeyId: identity.keyId,
        recipientKeyId: trust.gatewayKey.keyId,
      });
      content = {
        msgtype: sdk.MsgType.Notice,
        body: "Encrypted Codever message",
        "io.codever": {
          version: 1,
          kind: "secure_envelope",
          secure_envelope: secureEnvelope,
        },
      };
    } catch (error) {
      await abandonIncompleteCommand(
        config,
        identity,
        sequenceEpoch,
        reservation.commandId,
      );
      throw error;
    }
    const response = await client.sendMessage(
      config.roomId,
      content,
      `codever.${reservation.commandId}`,
    );
    return response.event_id;
  };
  const scanHistoryTimeline = async (
    room: Room,
    initialSessionId: string,
  ): Promise<void> => {
    if (!historyInitialized) {
      legacyHistorySessionHint = initialSessionId;
      historyInitialized = true;
    }
    const events = room
      .getLiveTimeline()
      .getEvents()
      .filter((event) => {
        const eventId = event.getId();
        return Boolean(eventId && !historySeen.has(eventId));
      })
      .reverse();
    for (const event of events) {
      const eventId = event.getId();
      if (!eventId) continue;
      const decoded = await decodeHistoricalEvent(
        client,
        event,
        config,
        identity,
        activeTrust,
        historyReplayStore,
      );
      historySeen.add(eventId);
      if (decoded?.gatewaySessionId !== undefined) {
        legacyHistorySessionHint = decoded.gatewaySessionId;
      }
      if (!decoded?.message) continue;
      const sessionId =
        decoded.message.sessionId ?? legacyHistorySessionHint;
      if (!sessionId) continue;
      const message = {
        ...decoded.message,
        sessionId,
        historical: true,
      };
      const history = historyBySession.get(sessionId) ?? [];
      if (!history.some((candidate) => candidate.eventId === message.eventId)) {
        history.push(message);
        history.sort(compareIncomingMessages);
        historyBySession.set(sessionId, history);
      }
    }
  };
  const takeHistory = (
    sessionId: string,
    limit: number,
  ): IncomingCodeverMessage[] => {
    const delivered = deliveredHistory.get(sessionId) ?? new Set<string>();
    deliveredHistory.set(sessionId, delivered);
    const available = (historyBySession.get(sessionId) ?? []).filter(
      (message) => !delivered.has(message.eventId),
    );
    const page = available.slice(-limit);
    for (const message of page) delivered.add(message.eventId);
    return page;
  };
  const hasPendingHistory = (sessionId: string): boolean => {
    const delivered = deliveredHistory.get(sessionId) ?? new Set<string>();
    return (historyBySession.get(sessionId) ?? []).some(
      (message) => !delivered.has(message.eventId),
    );
  };
  const loadHistoryPage = async (
    sessionId: string,
    limit = 30,
  ): Promise<MatrixHistoryPage> => {
    if (stopped) throw new Error("Matrix connection is closed.");
    const room = client.getRoom(config.roomId);
    if (!room) throw new Error("The Matrix room is not available.");
    const pageLimit = Math.max(1, Math.min(limit, 100));
    await scanHistoryTimeline(room, sessionId);
    let messages = takeHistory(sessionId, pageLimit);
    if (
      messages.length < pageLimit &&
      room.oldState.paginationToken !== null
    ) {
      // One Matrix request per pull keeps recovery progressive even when the
      // room contains traffic for several Codever sessions.
      await client.scrollback(room, Math.max(30, pageLimit));
      await scanHistoryTimeline(room, sessionId);
      messages = [
        ...takeHistory(sessionId, pageLimit - messages.length),
        ...messages,
      ].sort(compareIncomingMessages);
    }
    return {
      messages,
      hasMore:
        hasPendingHistory(sessionId) ||
        room.oldState.paginationToken !== null,
    };
  };
  const loadRecentHistory = async (
    sessionId: string,
    limit = 30,
  ): Promise<MatrixHistoryPage> => {
    if (stopped) throw new Error("Matrix connection is closed.");
    const room = client.getRoom(config.roomId);
    if (!room) throw new Error("The Matrix room is not available.");
    const pageLimit = Math.max(1, Math.min(limit, 100));
    await scanHistoryTimeline(room, sessionId);
    return {
      messages: takeHistory(sessionId, pageLimit),
      hasMore:
        hasPendingHistory(sessionId) ||
        room.oldState.paginationToken !== null,
    };
  };
  const enqueueHistoryOperation = (
    operation: () => Promise<MatrixHistoryPage>,
  ): Promise<MatrixHistoryPage> => {
    const queued = historyChain.then(operation);
    historyChain = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };
  return {
    identity,
    matrixDeviceKeys,
    deviceTransport: {
      homeserver: config.homeserver,
      roomId: config.roomId,
      userId: config.userId,
      deviceId: config.matrixDeviceId,
      ed25519: matrixDeviceKeys.ed25519,
    },
    client,
    async pair(preview, deviceName, signal) {
      if (stopped) throw new Error("Matrix connection is closed.");
      assertPersistenceHealthy();
      const offerTransport = preview.transport;
      assertMatchingPairingRoute(config, offerTransport);
      await verifyAndPinGatewayDevice(client, offerTransport);
      await client.getCrypto()?.forceDiscardSession(config.roomId);
      const transport = createMatrixPairingTransport(
        client,
        sdk.RoomEvent.Timeline,
        sdk.MsgType.Notice,
        config.roomId,
      );
      const trust = await completePairing(
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
        transport,
        signal,
      );
      activeTrust = trust;
      return trust;
    },
    send(payload) {
      const operation = outboundChain.then(() => sendPayload(payload));
      outboundChain = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    confirmRevisionRetry(commandId) {
      const operation = outboundChain.then(async () => {
        assertPersistenceHealthy();
        const conflict = pendingRevisionConflict;
        if (!conflict || conflict.reservation.commandId !== commandId) {
          throw new Error("This conflicted command is no longer pending.");
        }
        const reservation = await rebasePendingCommand(
          config,
          identity,
          conflict.sequenceEpoch,
          conflict.reservation,
          conflict.expectedRevision,
        );
        pendingRevisionConflict = null;
        return transmitOnce(
          reservation,
          conflict.payload,
          conflict.sequenceEpoch,
          conflict.trust,
        );
      });
      outboundChain = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    discardRevisionConflict(commandId) {
      const operation = outboundChain.then(async () => {
        const conflict = pendingRevisionConflict;
        if (!conflict || conflict.reservation.commandId !== commandId) return;
        await discardPendingCommand(
          config,
          identity,
          conflict.sequenceEpoch,
          commandId,
        );
        pendingRevisionConflict = null;
      });
      outboundChain = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    markHistoryLoaded(sessionId, eventIds) {
      const delivered = deliveredHistory.get(sessionId) ?? new Set<string>();
      deliveredHistory.set(sessionId, delivered);
      for (const eventId of eventIds) delivered.add(eventId);
    },
    loadRecentHistory(sessionId, limit) {
      return enqueueHistoryOperation(() =>
        loadRecentHistory(sessionId, limit),
      );
    },
    loadHistoryPage(sessionId, limit) {
      return enqueueHistoryOperation(() =>
        loadHistoryPage(sessionId, limit),
      );
    },
    stop() {
      if (stopped) return;
      stopped = true;
      client.off(sdk.RoomEvent.Timeline, onTimeline);
      client.off(sdk.ClientEvent.Sync, onSync);
      client.stopClient();
      handlers.onStatus("offline");
      void checkpointAndReleaseMatrixSyncStore(
        syncStoreDatabaseName,
        syncStore,
        cryptoLock,
      ).catch((error) => {
        handlers.onStatus(
          "error",
          `Matrix sync state could not be saved: ${formatError(error)}`,
        );
      });
    },
  };
}

function createMatrixPairingTransport(
  client: MatrixClient,
  timelineEvent: string,
  noticeType: MsgType.Notice,
  roomId: string,
): PairingTransport {
  return {
    async exchange(request, offer, signal) {
      const response = waitForPairingResponse(
        client,
        timelineEvent,
        roomId,
        request,
        offer,
        signal,
      );
      try {
        const content = {
          msgtype: noticeType,
          body: "Codever device pairing request",
          "io.codever": {
            version: 1,
            kind: "pairing_request",
            pairing_request: request,
          },
        };
        await client.sendMessage(
          roomId,
          content,
          `codever.pair.${request.request.requestId}.${crypto.randomUUID()}`,
        );
      } catch (error) {
        response.cancel();
        throw error;
      }
      return response.promise;
    },
  };
}

function waitForPairingResponse(
  client: MatrixClient,
  timelineEvent: string,
  roomId: string,
  request: SignedPairingRequest,
  offer: SignedPairingOffer,
  signal?: AbortSignal,
  timeoutMs = 45_000,
): {
  promise: Promise<SignedPairingResponse>;
  cancel(): void;
} {
  let cancel = () => {};
  const promise = new Promise<SignedPairingResponse>((resolve, reject) => {
    let settled = false;
    const finish = (
      outcome:
        | { response: SignedPairingResponse }
        | { error: Error },
    ) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      client.off(timelineEvent as never, listener as never);
      signal?.removeEventListener("abort", abort);
      if ("response" in outcome) resolve(outcome.response);
      else reject(outcome.error);
    };
    const abort = () =>
      finish({ error: new DOMException("Pairing was cancelled.", "AbortError") });
    const listener = (
      event: MatrixEvent,
      room: Room | undefined,
      toStartOfTimeline: boolean | undefined,
    ) => {
      if (toStartOfTimeline || room?.roomId !== roomId) return;
      void (async () => {
        if (event.getType() === "m.room.encrypted" || event.isEncrypted()) {
          await client.decryptEventIfNeeded(event);
        }
        if (event.isDecryptionFailure() || event.getType() !== "m.room.message") {
          return;
        }
        const content = asRecord(event.getContent());
        const extension = asRecord(content?.["io.codever"]);
        const candidate = extension?.pairing_response;
        if (extension?.kind !== "pairing_response" || !candidate) return;
        const parsed = candidate as SignedPairingResponse;
        if (
          parsed.response?.offerId !== offer.offer.offerId ||
          parsed.response?.requestId !== request.request.requestId
        ) {
          return;
        }
        // The response signature, hidden challenge, exact request hash and
        // certificate are the pairing authority. Allow Matrix to relay that
        // opaque response after a Gateway transport-device restart; the
        // homeserver cannot forge it with a substituted sender/device.
        try {
          await verifyPairingResponse(parsed, offer, request);
        } catch {
          // Untrusted room members may send lookalike responses. Ignore them
          // and keep waiting for the Gateway application-key signature.
          return;
        }
        finish({ response: parsed });
      })().catch((error) => {
        finish({ error: new Error(formatError(error)) });
      });
    };
    const timeout = window.setTimeout(
      () =>
        finish({
          error: new Error(
            "The Gateway did not approve this pairing request in time.",
          ),
        }),
      timeoutMs,
    );
    cancel = () =>
      finish({ error: new DOMException("Pairing was cancelled.", "AbortError") });
    client.on(timelineEvent as never, listener as never);
    if (signal?.aborted) abort();
    else {
      signal?.addEventListener("abort", abort, { once: true });
      const room = client.getRoom(roomId);
      if (room) {
        for (const event of room.getLiveTimeline().getEvents()) {
          listener(event, room, false);
        }
      }
    }
  });
  return { promise, cancel };
}

async function verifyAndPinGatewayDevice(
  client: MatrixClient,
  gateway: MatrixTransportBinding,
): Promise<void> {
  const cryptoApi = client.getCrypto();
  if (!cryptoApi) throw new Error("Matrix encryption is not ready.");
  // A newly logged-in Gateway device can appear in /keys/query before the
  // Rust crypto store has processed the corresponding /sync device-list
  // change. Keep the client syncing briefly instead of making the user retry.
  let device: Device | undefined;
  const deadline = Date.now() + 10_000;
  do {
    const devices = await cryptoApi.getUserDeviceInfo([gateway.userId], true);
    device = devices.get(gateway.userId)?.get(gateway.deviceId);
    if (device) break;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  if (!device) {
    throw new Error(
      "The signed Gateway Matrix device is not present in the trusted device list. Log in the Gateway as a new Matrix device, then pair this browser again.",
    );
  }
  if (device.getFingerprint() !== gateway.ed25519) {
    throw new Error("The Gateway device fingerprint does not match the invitation.");
  }
  await cryptoApi.setDeviceVerified(gateway.userId, gateway.deviceId, true);
}

function assertMatchingPairingRoute(
  config: MatrixConnectionConfig,
  gateway: MatrixTransportBinding,
): void {
  if (
    config.homeserver !== gateway.homeserver.replace(/\/+$/, "") ||
    config.roomId !== gateway.roomId
  ) {
    throw new Error("The connected Matrix room does not match this invitation.");
  }
}

export function parseCodeverEvent(
  eventId: string,
  sender: string,
  timestamp: number,
  encrypted: boolean,
  content: Record<string, unknown>,
): IncomingCodeverMessage | null {
  const extension = asRecord(content["io.codever"]);
  if (!extension || extension.version !== 1) return null;

  const relation = asRecord(content["m.relates_to"]);
  const replacement = asRecord(content["m.new_content"]);
  const effectiveContent = replacement ?? content;
  const effectiveExtension =
    asRecord(effectiveContent["io.codever"]) ?? extension;
  const body =
    typeof effectiveContent.body === "string" ? effectiveContent.body : "";
  const collaborationMetadata = {
    ...(typeof effectiveExtension.session_id === "string" &&
    effectiveExtension.session_id
      ? { sessionId: effectiveExtension.session_id }
      : {}),
    ...(isNonnegativeInteger(effectiveExtension.revision)
      ? { revision: effectiveExtension.revision }
      : {}),
    ...(isPositiveInteger(effectiveExtension.active_device_count)
      ? { activeDeviceCount: effectiveExtension.active_device_count }
      : {}),
  };

  if (effectiveExtension.kind === "signed_command") return null;
  if (
    effectiveExtension.kind === "collaboration_command" &&
    effectiveExtension.operation === "prompt" &&
    typeof effectiveExtension.command_id === "string" &&
    typeof effectiveExtension.text === "string" &&
    isPositiveInteger(effectiveExtension.revision) &&
    typeof effectiveExtension.origin_device_id === "string" &&
    typeof effectiveExtension.origin_device_name === "string"
  ) {
    return {
      eventId,
      sender,
      timestamp,
      encrypted,
      ...collaborationMetadata,
      kind: "user",
      text: effectiveExtension.text,
      commandId: effectiveExtension.command_id,
      revision: effectiveExtension.revision,
      originDeviceId: effectiveExtension.origin_device_id,
      originDeviceName: effectiveExtension.origin_device_name,
      ...(isPositiveInteger(effectiveExtension.active_device_count)
        ? { activeDeviceCount: effectiveExtension.active_device_count }
        : {}),
      raw: effectiveExtension,
    };
  }
  if (effectiveExtension.kind === "message") {
    const ui = asRecord(effectiveExtension.ui);
    return {
      eventId,
      sender,
      timestamp,
      encrypted,
      ...collaborationMetadata,
      kind: ui?.kind === "tool_card" ? "tool" : "agent",
      text: body,
      ...(typeof relation?.event_id === "string"
        ? { replacesEventId: relation.event_id }
        : {}),
      raw: effectiveExtension,
    };
  }
  if (effectiveExtension.kind === "decision_request") {
    return {
      eventId,
      sender,
      timestamp,
      encrypted,
      ...collaborationMetadata,
      kind: "permission",
      text:
        typeof effectiveExtension.title === "string"
          ? effectiveExtension.title
          : body,
      ...(typeof effectiveExtension.decision_id === "string"
        ? { requestId: effectiveExtension.decision_id }
        : {}),
      raw: effectiveExtension,
    };
  }
  if (effectiveExtension.kind === "status") {
    return {
      eventId,
      sender,
      timestamp,
      encrypted,
      ...collaborationMetadata,
      kind: "notice",
      text: body || "Gateway status updated.",
      raw: effectiveExtension,
    };
  }
  if (effectiveExtension.kind !== "signed_event") return null;

  const envelope =
    asRecord(effectiveExtension.signed_event) ??
    asRecord(effectiveExtension.envelope);
  const event = asRecord(envelope?.event);
  const payload = asRecord(event?.payload);
  if (!payload || typeof payload.type !== "string") return null;
  const common = {
    eventId,
    sender,
    timestamp,
    encrypted,
    ...collaborationMetadata,
    raw: payload,
  };

  switch (payload.type) {
    case "agent.text.delta":
    case "agent.text.completed":
      return {
        ...common,
        kind: "agent",
        text: typeof payload.text === "string" ? payload.text : "",
        ...(typeof payload.streamId === "string"
          ? { streamId: payload.streamId }
          : {}),
      };
    case "agent.tool.started":
    case "agent.tool.completed":
      return {
        ...common,
        kind: "tool",
        ...(typeof payload.toolCallId === "string"
          ? { toolCallId: payload.toolCallId }
          : {}),
        ...(payload.type === "agent.tool.started"
          ? { toolStatus: "running" as const }
          : payload.status === "succeeded" || payload.status === "failed"
            ? { toolStatus: payload.status }
            : {}),
        text:
          typeof payload.name === "string"
            ? payload.name
            : payload.type === "agent.tool.completed"
              ? `Tool ${String(payload.status ?? "completed")}`
              : "Agent tool",
      };
    case "agent.permission.requested":
      return {
        ...common,
        kind: "permission",
        text:
          typeof payload.title === "string"
            ? payload.title
            : "Permission required",
        ...(typeof payload.requestId === "string"
          ? { requestId: payload.requestId }
          : {}),
      };
    case "agent.error":
      return {
        ...common,
        kind: "error",
        text:
          typeof payload.message === "string"
            ? payload.message
            : "The agent reported an error.",
      };
    default:
      return {
        ...common,
        kind: "notice",
        text: humanizeField(payload.type),
      };
  }
}

type DecodedHistoricalEvent = {
  gatewaySessionId?: string | null;
  message?: IncomingCodeverMessage;
};

/**
 * Opens an archived Gateway envelope on a display-only path. This function
 * cannot acknowledge commands, advance revisions, resolve results, rotate
 * trust, or execute decisions. Envelope expiry is evaluated at the signed
 * issue time because expiry prevents delayed execution; it does not make an
 * already-authenticated archive unreadable.
 */
async function decodeHistoricalEvent(
  client: MatrixClient,
  event: MatrixEvent,
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  trust: TrustedGateway | null,
  replayStore: ReplayStore,
): Promise<DecodedHistoricalEvent | null> {
  const eventId = event.getId();
  const sender = event.getSender();
  if (!eventId || !sender || sender === config.userId || !trust) return null;
  if (event.getType() === "m.room.encrypted" || event.isEncrypted()) {
    await client.decryptEventIfNeeded(event);
  }
  if (event.isDecryptionFailure() || event.getType() !== "m.room.message") {
    return null;
  }
  const content = asRecord(event.getContent());
  const extension = asRecord(content?.["io.codever"]);
  if (
    !content ||
    extension?.kind !== "secure_envelope" ||
    !extension.secure_envelope
  ) {
    return null;
  }
  const routed = signedSecureEnvelopeSchema.safeParse(
    extension.secure_envelope,
  );
  if (!routed.success) {
    throw new Error("An archived Gateway envelope is malformed.");
  }
  if (
    routed.data.envelope.recipientDeviceId !==
      trust.certificate.certificate.deviceId ||
    routed.data.envelope.recipientKeyId !== identity.keyId
  ) {
    return null;
  }
  const opened = await openSecureEnvelope(extension.secure_envelope, {
    recipientPrivateKey: identity.privateKey,
    senderPublicKey: trust.gatewayKey.publicKey,
    expected: {
      gatewayId: trust.gatewayId,
      conversationId: config.conversationId,
      direction: "gateway_to_device",
      senderDeviceId: trust.certificate.certificate.gatewayId,
      recipientDeviceId: trust.certificate.certificate.deviceId,
      senderKeyId: trust.gatewayKey.keyId,
      recipientKeyId: identity.keyId,
    },
    replayStore,
    now: routed.data.envelope.issuedAt,
  });
  const decryptedContent = asRecord(opened.plaintext);
  if (!decryptedContent) {
    throw new Error(
      "An archived Gateway envelope did not contain Matrix content.",
    );
  }
  const decryptedExtension = asRecord(decryptedContent["io.codever"]);
  const gatewayState = parseGatewayStateExtension(decryptedExtension);
  if (gatewayState) {
    return { gatewaySessionId: gatewayState.currentSessionId };
  }
  if (decryptedExtension?.kind === "command_result") {
    if (
      decryptedExtension.outcome !== "failed" ||
      typeof decryptedExtension.command_id !== "string"
    ) {
      return null;
    }
    return {
      message: {
        eventId,
        sender: trust.gatewayId,
        timestamp: event.getTs(),
        encrypted: true,
        kind: "error",
        text:
          typeof decryptedExtension.error === "string"
            ? decryptedExtension.error
            : "The Gateway accepted the command but could not complete it.",
        commandId: decryptedExtension.command_id,
        ...(isPositiveInteger(decryptedExtension.revision)
          ? { revision: decryptedExtension.revision }
          : {}),
        ...(typeof decryptedExtension.session_id === "string" &&
        decryptedExtension.session_id
          ? { sessionId: decryptedExtension.session_id }
          : {}),
        historical: true,
        raw: decryptedExtension,
      },
    };
  }
  if (
    decryptedExtension?.kind === "command_ack" ||
    decryptedExtension?.kind === "revision_conflict"
  ) {
    return null;
  }
  const message = parseCodeverEvent(
    eventId,
    trust.gatewayId,
    event.getTs(),
    true,
    decryptedContent,
  );
  return message
    ? { message: { ...message, historical: true } }
    : null;
}

function compareIncomingMessages(
  left: IncomingCodeverMessage,
  right: IncomingCodeverMessage,
): number {
  return (
    left.timestamp - right.timestamp ||
    left.eventId.localeCompare(right.eventId)
  );
}

async function forwardEvent(
  client: MatrixClient,
  event: MatrixEvent,
  seen: Set<string>,
  config: MatrixConnectionConfig,
  onMessage: (message: IncomingCodeverMessage) => void,
  onTrustUpdated?: (trust: TrustedGateway) => void,
  identity?: DeviceIdentity,
  getTrust?: () => TrustedGateway | null,
  replayStore?: ReplayStore,
  onCommandAcknowledged?: (
    commandId: string,
    sequence: number,
    revision: number,
    revisionEpoch: string,
    activeDeviceCount?: number,
  ) => Promise<void>,
  onRevisionConflict?: (
    commandId: string,
    expectedRevision: number,
    revisionEpoch: string,
    activeDeviceCount?: number,
  ) => Promise<void>,
  onKnownRevision?: (
    revision: number,
    revisionEpoch: string,
    activeDeviceCount?: number,
  ) => Promise<void>,
  onCommandResult?: (
    result: CommandResultState,
    revisionEpoch: string,
    activeDeviceCount?: number,
  ) => Promise<void>,
  onGatewayState?: (state: GatewayStateSnapshot) => Promise<void>,
  historical = false,
): Promise<void> {
  const eventId = event.getId();
  const sender = event.getSender();
  if (!eventId || !sender || seen.has(eventId)) return;
  if (sender === config.userId) {
    // The room timeline echoes this device's outbound application envelope.
    // It has the opposite direction binding and is not an inbound message.
    seen.add(eventId);
    return;
  }
  if (event.getType() === "m.room.encrypted" || event.isEncrypted()) {
    await client.decryptEventIfNeeded(event);
  }
  if (event.isDecryptionFailure()) {
    // A fresh Matrix device cannot decrypt room history sent before it joined.
    // Undecryptable events must not prevent pairing or become a homeserver DoS.
    seen.add(eventId);
    return;
  }
  if (event.getType() !== "m.room.message") return;
  const content = asRecord(event.getContent());
  if (!content) return;
  const extension = asRecord(content["io.codever"]);
  if (
    extension?.kind === "gateway_device_rotation" &&
    extension.gateway_device_rotation
  ) {
    await acceptGatewayDeviceRotation(
      client,
      event,
      config,
      extension.gateway_device_rotation,
      onMessage,
      onTrustUpdated,
      identity,
    );
    seen.add(eventId);
    return;
  }
  if (
    extension?.kind !== "secure_envelope" ||
    !extension.secure_envelope ||
    !identity ||
    !getTrust ||
    !replayStore
  ) {
    // Legacy Matrix plaintext is intentionally ignored. Pairing and signed
    // device rotation are the only non-envelope control events.
    seen.add(eventId);
    return;
  }
  const trust = getTrust();
  if (!trust) {
    seen.add(eventId);
    return;
  }
  const routedEnvelope = signedSecureEnvelopeSchema.safeParse(
    extension.secure_envelope,
  );
  if (
    routedEnvelope.success &&
    (routedEnvelope.data.envelope.recipientDeviceId !==
      trust.certificate.certificate.deviceId ||
      routedEnvelope.data.envelope.recipientKeyId !== identity.keyId)
  ) {
    // A shared room contains one independently encrypted copy per paired
    // browser. The authenticated open below remains mandatory for messages
    // addressed to us; this untrusted header is used only to route away
    // another device's ciphertext without turning the connection red.
    seen.add(eventId);
    return;
  }
  let opened;
  try {
    opened = await openSecureEnvelope(extension.secure_envelope, {
      // Device IDs are certificate identities. They are intentionally separate
      // from both Matrix transport IDs and application key IDs.
      recipientPrivateKey: identity.privateKey,
      senderPublicKey: trust.gatewayKey.publicKey,
      expected: {
        gatewayId: trust.gatewayId,
        conversationId: config.conversationId,
        direction: "gateway_to_device",
        senderDeviceId: trust.certificate.certificate.gatewayId,
        recipientDeviceId: trust.certificate.certificate.deviceId,
        senderKeyId: trust.gatewayKey.keyId,
        recipientKeyId: identity.keyId,
      },
      replayStore,
    });
  } catch (error) {
    if (error instanceof SecurityError && error.code === "replay") {
      // Initial sync includes already-rendered history. Persistent replay state
      // keeps it non-executable; it should not turn a normal reconnect red.
      seen.add(eventId);
      return;
    }
    throw error;
  }
  const decryptedContent = asRecord(opened.plaintext);
  if (!decryptedContent) {
    throw new Error("The secure Gateway envelope did not contain Matrix content.");
  }
  const decryptedExtension = asRecord(decryptedContent["io.codever"]);
  const gatewayState = parseGatewayStateExtension(decryptedExtension);
  if (gatewayState) {
    await onGatewayState?.(gatewayState);
    seen.add(eventId);
    return;
  }
  if (decryptedExtension?.kind === "command_ack") {
    if (
      typeof decryptedExtension.command_id !== "string" ||
      !isPositiveInteger(decryptedExtension.sequence) ||
      !isPositiveInteger(decryptedExtension.revision) ||
      typeof decryptedExtension.revision_epoch !== "string" ||
      !decryptedExtension.revision_epoch
    ) {
      throw new Error("The authenticated command acknowledgement is malformed.");
    }
    await onCommandAcknowledged?.(
      decryptedExtension.command_id,
      decryptedExtension.sequence,
      decryptedExtension.revision,
      decryptedExtension.revision_epoch,
      isPositiveInteger(decryptedExtension.active_device_count)
        ? decryptedExtension.active_device_count
        : undefined,
    );
    seen.add(eventId);
    return;
  }
  if (decryptedExtension?.kind === "revision_conflict") {
    if (
      typeof decryptedExtension.command_id !== "string" ||
      !isNonnegativeInteger(decryptedExtension.expected_revision) ||
      typeof decryptedExtension.revision_epoch !== "string" ||
      !decryptedExtension.revision_epoch
    ) {
      throw new Error("The authenticated revision conflict is malformed.");
    }
    await onRevisionConflict?.(
      decryptedExtension.command_id,
      decryptedExtension.expected_revision,
      decryptedExtension.revision_epoch,
      isPositiveInteger(decryptedExtension.active_device_count)
        ? decryptedExtension.active_device_count
        : undefined,
    );
    seen.add(eventId);
    return;
  }
  if (decryptedExtension?.kind === "command_result") {
    if (
      typeof decryptedExtension.command_id !== "string" ||
      !isPositiveInteger(decryptedExtension.sequence) ||
      !isPositiveInteger(decryptedExtension.revision) ||
      typeof decryptedExtension.revision_epoch !== "string" ||
      !decryptedExtension.revision_epoch ||
      !(
        decryptedExtension.outcome === "succeeded" ||
        decryptedExtension.outcome === "failed"
      )
    ) {
      throw new Error("The authenticated command result is malformed.");
    }
    const activeDeviceCount = isPositiveInteger(
      decryptedExtension.active_device_count,
    )
      ? decryptedExtension.active_device_count
      : undefined;
    await onCommandResult?.(
      {
        commandId: decryptedExtension.command_id,
        sequence: decryptedExtension.sequence,
        revision: decryptedExtension.revision,
        outcome: decryptedExtension.outcome,
        ...(typeof decryptedExtension.session_id === "string" &&
        decryptedExtension.session_id
          ? { sessionId: decryptedExtension.session_id }
          : {}),
        ...(decryptedExtension.result === undefined
          ? {}
          : {
              result: jsonValueSchema.parse(
                decryptedExtension.result,
              ) as JsonValue,
            }),
      },
      decryptedExtension.revision_epoch,
      activeDeviceCount,
    );
    if (decryptedExtension.outcome === "failed") {
      onMessage({
        eventId,
        sender: trust.gatewayId,
        timestamp: event.getTs(),
        encrypted: true,
        kind: "error",
        text:
          typeof decryptedExtension.error === "string"
            ? decryptedExtension.error
            : "The Gateway accepted the command but could not complete it.",
        commandId: decryptedExtension.command_id,
        revision: decryptedExtension.revision,
        ...(typeof decryptedExtension.session_id === "string" &&
        decryptedExtension.session_id
          ? { sessionId: decryptedExtension.session_id }
          : {}),
        ...(historical ? { historical: true } : {}),
        raw: decryptedExtension,
      });
    }
    seen.add(eventId);
    return;
  }
  const parsed = parseCodeverEvent(
    eventId,
    trust.gatewayId,
    event.getTs(),
    true,
    decryptedContent,
  );
  seen.add(eventId);
  if (!parsed) return;
  if (
    parsed.revision !== undefined &&
    typeof decryptedExtension?.revision_epoch === "string" &&
    decryptedExtension.revision_epoch
  ) {
    await onKnownRevision?.(
      parsed.revision,
      decryptedExtension.revision_epoch,
      parsed.activeDeviceCount,
    );
  }
  onMessage(historical ? { ...parsed, historical: true } : parsed);
}

async function acceptGatewayDeviceRotation(
  client: MatrixClient,
  event: MatrixEvent,
  config: MatrixConnectionConfig,
  input: unknown,
  onMessage: (message: IncomingCodeverMessage) => void,
  onTrustUpdated?: (trust: TrustedGateway) => void,
  identity?: DeviceIdentity,
): Promise<void> {
  const trust = await loadTrustedGateway(identity);
  if (!trust) return;
  const signedRotation = signedGatewayDeviceRotationSchema.parse(input);
  if (
    trust.rotations.some(
      (known) =>
        known.rotation.rotationId === signedRotation.rotation.rotationId,
    )
  ) {
    return;
  }
  // The replacement device sends this event, so transport identity is checked
  // only after the persistent Gateway application key authorizes the rotation.
  const rotation = await verifyGatewayDeviceRotation(
    signedRotation,
    trust.gatewayKey.publicKey,
    {
      gatewayId: trust.gatewayId,
      previousTransport: trust.gatewayTransport,
      issuedAfter:
        trust.rotations.at(-1)?.rotation.issuedAt ??
        trust.certificate.certificate.issuedAt,
    },
  );
  assertMatrixEventMatchesTransport(event, rotation.nextTransport);
  await verifyAndPinGatewayDevice(client, rotation.nextTransport);
  // The existing Megolm outbound session was created before the replacement
  // Gateway Matrix device existed, so it has no room key for that device.
  // Rotate the transport session after the application-signed device rotation.
  await client.getCrypto()?.forceDiscardSession(config.roomId);
  const nextTrust: TrustedGateway = {
    ...trust,
    gatewayTransport: rotation.nextTransport,
    rotations: [
      ...trust.rotations,
      signedRotation,
    ],
  };
  saveTrustedGateway(nextTrust);
  config.gatewayMatrixUserId = rotation.nextTransport.userId;
  config.gatewayMatrixDeviceId = rotation.nextTransport.deviceId;
  config.gatewayMatrixEd25519 = rotation.nextTransport.ed25519;
  saveMatrixConfig(config);
  onTrustUpdated?.(nextTrust);
  onMessage({
    eventId: event.getId() ?? `gateway-rotation-${rotation.rotationId}`,
    sender: rotation.nextTransport.userId,
    timestamp: event.getTs(),
    encrypted: event.isEncrypted(),
    kind: "notice",
    text: "Gateway security keys were updated automatically.",
    raw: { type: "gateway.device.rotated", rotationId: rotation.rotationId },
  });
}

function assertMatrixEventMatchesTransport(
  event: MatrixEvent,
  transport: MatrixTransportBinding,
): void {
  if (
    event.getSender() !== transport.userId ||
    event.getClaimedEd25519Key() !== transport.ed25519
  ) {
    throw new Error(
      "Rejected a Gateway rotation that was not sent by its signed replacement device.",
    );
  }
}

function gatewayPin(config: MatrixConnectionConfig): {
  userId: string;
  deviceId: string;
  ed25519: string;
} | null {
  const values = [
    config.gatewayMatrixUserId,
    config.gatewayMatrixDeviceId,
    config.gatewayMatrixEd25519,
  ];
  if (values.every((value) => !value)) return null;
  if (values.some((value) => !value)) {
    throw new Error(
      "Gateway Matrix user, device ID, and Ed25519 fingerprint must be provided together.",
    );
  }
  if (!config.gatewayMatrixUserId.startsWith("@")) {
    throw new Error("Gateway Matrix user ID must start with @.");
  }
  return {
    userId: config.gatewayMatrixUserId,
    deviceId: config.gatewayMatrixDeviceId,
    ed25519: config.gatewayMatrixEd25519,
  };
}

function waitForInitialSync(
  client: MatrixClient,
  syncEvent: string,
  timeoutMs = 30_000,
): Promise<void> {
  if (client.getSyncState() === "PREPARED" || client.getSyncState() === "SYNCING") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      client.off(syncEvent as never, listener as never);
      reject(new Error("Timed out waiting for the first Matrix sync."));
    }, timeoutMs);
    const listener = (state: string) => {
      if (state === "PREPARED" || state === "SYNCING") {
        window.clearTimeout(timeout);
        client.off(syncEvent as never, listener as never);
        resolve();
      } else if (state === "ERROR") {
        window.clearTimeout(timeout);
        client.off(syncEvent as never, listener as never);
        reject(new Error("Matrix rejected the connection or access token."));
      }
    };
    client.on(syncEvent as never, listener as never);
  });
}

function openIdentityDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DEVICE_DATABASE, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DEVICE_STORE)) {
        request.result.createObjectStore(DEVICE_STORE);
      }
      if (!request.result.objectStoreNames.contains(COMMAND_SEQUENCE_STORE)) {
        request.result.createObjectStore(COMMAND_SEQUENCE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open the device key store."));
  });
}

function commandSequenceScope(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  sequenceEpoch: string,
): string {
  return JSON.stringify([
    config.gatewayId,
    identity.keyId,
    config.conversationId,
    sequenceEpoch,
  ]);
}

function gatewayEpochScope(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
): string {
  return JSON.stringify([
    "gateway-epoch-v1",
    config.gatewayId,
    identity.keyId,
    config.conversationId,
  ]);
}

function gatewayStateCacheBinding(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  certificateId: string,
): GatewayStateCacheBinding {
  return {
    gatewayId: config.gatewayId,
    conversationId: config.conversationId,
    identityKeyId: identity.keyId,
    certificateId,
  };
}

function gatewayStateCacheScope(binding: GatewayStateCacheBinding): string {
  return JSON.stringify([
    "gateway-state-cache-v1",
    binding.gatewayId,
    binding.identityKeyId,
    binding.conversationId,
    binding.certificateId,
  ]);
}

async function loadCachedGatewayState(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  certificateId: string,
): Promise<GatewayStateSnapshot | null> {
  const database = await openIdentityDatabase();
  const binding = gatewayStateCacheBinding(config, identity, certificateId);
  try {
    return await new Promise<GatewayStateSnapshot | null>((resolve, reject) => {
      const transaction = database.transaction(
        COMMAND_SEQUENCE_STORE,
        "readonly",
      );
      const store = transaction.objectStore(COMMAND_SEQUENCE_STORE);
      const epochRead = store.get(gatewayEpochScope(config, identity));
      const cacheRead = store.get(gatewayStateCacheScope(binding));
      transaction.oncomplete = () => {
        try {
          const epoch = parseDurableGatewayEpochState(epochRead.result);
          resolve(
            epoch
              ? parseGatewayStateCacheRecord(cacheRead.result, binding, epoch)
              : null,
          );
        } catch (error) {
          reject(error);
        }
      };
      transaction.onerror = () =>
        reject(
          transaction.error ??
            new Error("Could not read the cached Gateway state."),
        );
      transaction.onabort = () =>
        reject(
          transaction.error ??
            new Error("Could not read the cached Gateway state."),
        );
    });
  } finally {
    database.close();
  }
}

async function reserveCommandSequence(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  sequenceEpoch: string,
  payload: CommandPayload,
  now = Date.now(),
): Promise<CommandReservation> {
  const database = await openIdentityDatabase();
  const scope = commandSequenceScope(config, identity, sequenceEpoch);
  try {
    return await new Promise<CommandReservation>((resolve, reject) => {
      const transaction = database.transaction(
        COMMAND_SEQUENCE_STORE,
        "readwrite",
      );
      const store = transaction.objectStore(COMMAND_SEQUENCE_STORE);
      const read = store.get(scope);
      let reservation: CommandReservation | null = null;
      let failure: Error | null = null;
      read.onsuccess = () => {
        const state = parseCommandSequenceState(read.result);
        if (!state.revisionInitialized) {
          failure = new Error(
            "Waiting for the current Gateway session state before sending.",
          );
          transaction.abort();
          return;
        }
        if (state.pending) {
          failure = new Error(
            "Another Codever command is still waiting to be delivered.",
          );
          transaction.abort();
          return;
        }
        reservation = {
          commandId: crypto.randomUUID(),
          sequence: state.lastAcknowledged + 1,
          baseRevision: state.lastRevision,
          revisionEpoch: state.revisionEpoch!,
        };
        store.put(
          {
            ...state,
            pending: {
              ...reservation,
              createdAt: now,
              payload: structuredClone(payload),
            },
          } satisfies CommandSequenceState,
          scope,
        );
      };
      read.onerror = () => transaction.abort();
      transaction.oncomplete = () => {
        if (!reservation) {
          reject(new Error("Could not reserve the next command sequence."));
          return;
        }
        resolve(reservation);
      };
      transaction.onerror = () =>
        reject(
          failure ??
          transaction.error ??
            new Error("Could not reserve the next command sequence."),
        );
      transaction.onabort = () =>
        reject(
          failure ??
          transaction.error ??
            new Error("Could not reserve the next command sequence."),
        );
    });
  } finally {
    database.close();
  }
}

async function assertRevisionInitialized(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  sequenceEpoch: string,
): Promise<void> {
  const state = await readCommandSequenceState(
    commandSequenceScope(config, identity, sequenceEpoch),
  );
  if (!state.revisionInitialized) {
    throw new Error(
      "Waiting for the current Gateway session state before sending.",
    );
  }
  if (!state.revisionEpoch) {
    throw new Error("The Gateway revision epoch is not initialized.");
  }
}

async function savePendingCommandPlaintext(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  sequenceEpoch: string,
  commandId: string,
  plaintext: Record<string, unknown>,
): Promise<void> {
  await updateCommandSequenceState(
    commandSequenceScope(config, identity, sequenceEpoch),
    (state) => {
      if (!state.pending || state.pending.commandId !== commandId) {
        throw new Error("The outbound command reservation was lost.");
      }
      return {
        ...state,
        pending: {
          ...state.pending,
          plaintext: structuredClone(plaintext),
        },
      };
    },
  );
}

async function acknowledgePendingCommand(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  sequenceEpoch: string,
  reservation: CommandReservation,
  revision: number,
  revisionEpoch: string,
): Promise<void> {
  await updateCommandSequenceState(
    commandSequenceScope(config, identity, sequenceEpoch),
    (state) => {
      assertMatchingRevisionEpoch(state, revisionEpoch);
      if (reservation.revisionEpoch !== revisionEpoch) {
        throw new Error(
          "Rejected an acknowledgement for a different revision epoch.",
        );
      }
      if (state.lastAcknowledged >= reservation.sequence) {
        return {
          ...state,
          lastRevision: Math.max(state.lastRevision, revision),
          revisionInitialized: true,
        };
      }
      if (!state.pending) {
        return {
          ...state,
          lastAcknowledged: reservation.sequence,
          lastRevision: Math.max(state.lastRevision, revision),
          revisionInitialized: true,
          pending: undefined,
        };
      }
      if (
        state.pending.commandId === reservation.commandId &&
        state.pending.sequence === reservation.sequence
      ) {
        return {
          ...state,
          lastAcknowledged: reservation.sequence,
          lastRevision: Math.max(state.lastRevision, revision),
          revisionInitialized: true,
          pending: undefined,
        };
      }
      // A historical acknowledgement for a different command must not clear
      // the current outbox reservation.
      return state;
    },
  );
}

function assertMatchingRevisionEpoch(
  state: CommandSequenceState,
  revisionEpoch: string,
): void {
  if (
    !state.revisionInitialized ||
    !state.revisionEpoch ||
    state.revisionEpoch !== revisionEpoch
  ) {
    throw new Error(
      "Rejected an authenticated Gateway event from a different revision epoch.",
    );
  }
}

async function initializeKnownRevision(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  certificateId: string,
  gatewayState: GatewayStateSnapshot,
): Promise<boolean> {
  const {
    revisionEpoch,
    revisionEpochGeneration,
    revision,
    stateVersion,
  } = gatewayState;
  const database = await openIdentityDatabase();
  const commandScope = commandSequenceScope(config, identity, certificateId);
  const epochScope = gatewayEpochScope(config, identity);
  const cacheBinding = gatewayStateCacheBinding(
    config,
    identity,
    certificateId,
  );
  const cacheScope = gatewayStateCacheScope(cacheBinding);
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(
        COMMAND_SEQUENCE_STORE,
        "readwrite",
      );
      const store = transaction.objectStore(COMMAND_SEQUENCE_STORE);
      const commandRead = store.get(commandScope);
      const epochRead = store.get(epochScope);
      let accepted = false;
      let failure: Error | null = null;
      let readsCompleted = 0;
      const applySnapshot = () => {
        readsCompleted += 1;
        if (readsCompleted !== 2) return;
        try {
          const state = parseCommandSequenceState(commandRead.result);
          const epochState = parseDurableGatewayEpochState(epochRead.result);
          const migratingLegacyState =
            !epochState &&
            state.revisionInitialized &&
            Boolean(state.revisionEpoch);
          if (
            migratingLegacyState &&
            !canMigrateLegacyGatewayState(
              state.revisionEpoch!,
              state.stateVersion,
              revisionEpoch,
              stateVersion,
            )
          ) {
            throw new Error(
              "Refusing to migrate to a new revision epoch without a newer Gateway state version.",
            );
          }
          const epochStatus = classifyGatewayStateEpoch(
            epochState?.revisionEpoch,
            epochState?.revisionEpochGeneration,
            epochState?.retiredRevisionEpochs ??
              state.retiredRevisionEpochs,
            revisionEpoch,
            revisionEpochGeneration,
          );
          if (epochStatus === "retired" || epochStatus === "stale") {
            throw new Error(
              "Rejected a Gateway state snapshot from an older revision epoch generation.",
            );
          }
          if (epochStatus === "conflict") {
            throw new Error(
              "Rejected a Gateway state snapshot that changed epoch without advancing its generation.",
            );
          }
          const migrationKeepsEpoch =
            migratingLegacyState && state.revisionEpoch === revisionEpoch;
          const sameEpoch =
            (epochState !== null && epochStatus === "current") ||
            migrationKeepsEpoch;
          const baselineStateVersion =
            epochState?.stateVersion ?? state.stateVersion;
          const baselineRevision =
            epochState?.revision ?? state.lastRevision;
          if (
            sameEpoch &&
            (stateVersion < baselineStateVersion ||
              (stateVersion === baselineStateVersion &&
                revision !== baselineRevision))
          ) {
            throw new Error(
              "Rejected an inconsistent or stale Gateway state snapshot.",
            );
          }
          if (sameEpoch && revision < baselineRevision) {
            throw new Error(
              "Rejected a Gateway state snapshot with a regressed revision.",
            );
          }
          const retiredRevisionEpochs = sameEpoch
            ? epochState?.retiredRevisionEpochs ??
              state.retiredRevisionEpochs
            : [
                ...new Set([
                  ...(epochState?.retiredRevisionEpochs ??
                    state.retiredRevisionEpochs),
                  ...(epochState?.revisionEpoch || state.revisionEpoch
                    ? [epochState?.revisionEpoch ?? state.revisionEpoch!]
                    : []),
                ]),
              ];
          const commandAlreadyCurrent =
            state.revisionInitialized &&
            state.revisionEpoch === revisionEpoch &&
            (state.revisionEpochGeneration === undefined ||
              state.revisionEpochGeneration === revisionEpochGeneration);
          const durableStateChanged =
            epochState === null ||
            !commandAlreadyCurrent ||
            !sameEpoch ||
            stateVersion > state.stateVersion;
          accepted = true;
          store.put(
            createGatewayStateCacheRecord(cacheBinding, gatewayState),
            cacheScope,
          );
          if (!durableStateChanged) return;

          const nextEpochState: DurableGatewayEpochState = {
            revisionEpoch,
            revisionEpochGeneration,
            revision,
            stateVersion,
            retiredRevisionEpochs,
          };
          store.put(nextEpochState, epochScope);
          store.put(
            commandAlreadyCurrent
              ? {
                  ...state,
                  lastRevision: revision,
                  revisionEpochGeneration,
                  stateVersion,
                }
              : {
                  lastAcknowledged: 0,
                  lastRevision: revision,
                  revisionInitialized: true,
                  revisionEpoch,
                  revisionEpochGeneration,
                  retiredRevisionEpochs,
                  stateVersion,
                },
            commandScope,
          );
        } catch (error) {
          failure =
            error instanceof Error ? error : new Error(String(error));
          transaction.abort();
        }
      };
      commandRead.onsuccess = applySnapshot;
      epochRead.onsuccess = applySnapshot;
      commandRead.onerror = () => transaction.abort();
      epochRead.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve(accepted);
      transaction.onerror = () =>
        reject(
          failure ??
            transaction.error ??
            new Error("Could not initialize the Gateway revision state."),
        );
      transaction.onabort = () =>
        reject(
          failure ??
            transaction.error ??
            new Error("Could not initialize the Gateway revision state."),
        );
    });
  } finally {
    database.close();
  }
}

async function recordKnownRevision(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  sequenceEpoch: string,
  revision: number,
  revisionEpoch: string,
): Promise<void> {
  await updateCommandSequenceState(
    commandSequenceScope(config, identity, sequenceEpoch),
    (state) => {
      assertMatchingRevisionEpoch(state, revisionEpoch);
      return {
        ...state,
        lastRevision: Math.max(state.lastRevision, revision),
      };
    },
  );
}

async function rebasePendingCommand(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  sequenceEpoch: string,
  reservation: CommandReservation,
  expectedRevision: number,
): Promise<CommandReservation> {
  const next: CommandReservation = {
    commandId: crypto.randomUUID(),
    sequence: reservation.sequence,
    baseRevision: expectedRevision,
    revisionEpoch: reservation.revisionEpoch,
  };
  await updateCommandSequenceState(
    commandSequenceScope(config, identity, sequenceEpoch),
    (state) => {
      if (
        state.pending?.commandId !== reservation.commandId ||
        state.pending.sequence !== reservation.sequence
      ) {
        throw new Error("The command changed before it could be safely rebased.");
      }
      assertMatchingRevisionEpoch(state, reservation.revisionEpoch);
      return {
        ...state,
        lastRevision: Math.max(state.lastRevision, expectedRevision),
        pending: {
          ...state.pending,
          ...next,
          createdAt: Date.now(),
          plaintext: undefined,
        },
      };
    },
  );
  return next;
}

async function abandonIncompleteCommand(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  sequenceEpoch: string,
  commandId: string,
): Promise<void> {
  await updateCommandSequenceState(
    commandSequenceScope(config, identity, sequenceEpoch),
    (state) =>
      state.pending?.commandId === commandId && !state.pending.plaintext
        ? {
            ...state,
            lastAcknowledged: state.lastAcknowledged,
            lastRevision: state.lastRevision,
            pending: undefined,
          }
        : state,
  );
}

async function discardPendingCommand(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  sequenceEpoch: string,
  commandId: string,
): Promise<void> {
  await updateCommandSequenceState(
    commandSequenceScope(config, identity, sequenceEpoch),
    (state) =>
      state.pending?.commandId === commandId
        ? {
            ...state,
            lastAcknowledged: state.lastAcknowledged,
            lastRevision: state.lastRevision,
            pending: undefined,
          }
        : state,
  );
}

async function retryPendingCommand(
  client: MatrixClient,
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  sequenceEpoch: string,
  trust: TrustedGateway,
): Promise<{
  eventId: string;
  payload: CommandPayload;
  reservation: CommandReservation;
} | null> {
  const scope = commandSequenceScope(config, identity, sequenceEpoch);
  const state = await readCommandSequenceState(scope);
  const pending = state.pending;
  if (!pending) return null;
  assertMatchingRevisionEpoch(state, pending.revisionEpoch);
  if (!pending.plaintext) {
    if (Date.now() - pending.createdAt < INCOMPLETE_OUTBOX_LEASE_MS) {
      throw new Error("Another tab is preparing a Codever command.");
    }
    await updateCommandSequenceState(scope, (current) =>
      current.pending?.commandId === pending.commandId
        ? {
            ...current,
            lastAcknowledged: current.lastAcknowledged,
            lastRevision: current.lastRevision,
            pending: undefined,
          }
        : current,
    );
    return null;
  }
  const extension = asRecord(pending.plaintext["io.codever"]);
  const signed = asRecord(extension?.signed_command);
  const command = asRecord(signed?.command);
  if (
    typeof command?.expiresAt !== "number" ||
    command.expiresAt <= Date.now()
  ) {
    throw new Error(
      "A queued command expired before the Gateway confirmed it. Re-pair this device to start a fresh secure command sequence.",
    );
  }
  const certificate = trust.certificate.certificate;
  const secureEnvelope = await sealSecureEnvelope({
    plaintext: pending.plaintext,
    senderPrivateKey: identity.privateKey,
    recipientPublicKey: trust.gatewayKey.publicKey,
    gatewayId: trust.gatewayId,
    conversationId: config.conversationId,
    direction: "device_to_gateway",
    senderDeviceId: certificate.deviceId,
    recipientDeviceId: certificate.gatewayId,
    senderKeyId: identity.keyId,
    recipientKeyId: trust.gatewayKey.keyId,
  });
  const content = {
    msgtype: "m.notice",
    body: "Encrypted Codever message",
    "io.codever": {
      version: 1,
      kind: "secure_envelope",
      secure_envelope: secureEnvelope,
    },
  };
  const response = await client.sendMessage(
    config.roomId,
    content,
    `codever.${pending.commandId}.retry.${crypto.randomUUID()}`,
  );
  return {
    eventId: response.event_id,
    payload: pending.payload,
    reservation: pending,
  };
}

async function readCommandSequenceState(
  scope: string,
): Promise<CommandSequenceState> {
  const database = await openIdentityDatabase();
  try {
    return await new Promise<CommandSequenceState>((resolve, reject) => {
      const request = database
        .transaction(COMMAND_SEQUENCE_STORE, "readonly")
        .objectStore(COMMAND_SEQUENCE_STORE)
        .get(scope);
      request.onsuccess = () =>
        resolve(parseCommandSequenceState(request.result));
      request.onerror = () =>
        reject(
          request.error ?? new Error("Could not read the command outbox."),
        );
    });
  } finally {
    database.close();
  }
}

async function updateCommandSequenceState(
  scope: string,
  update: (state: CommandSequenceState) => CommandSequenceState,
): Promise<void> {
  const database = await openIdentityDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        COMMAND_SEQUENCE_STORE,
        "readwrite",
      );
      const store = transaction.objectStore(COMMAND_SEQUENCE_STORE);
      const request = store.get(scope);
      let failure: Error | null = null;
      request.onsuccess = () => {
        try {
          store.put(update(parseCommandSequenceState(request.result)), scope);
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          transaction.abort();
        }
      };
      request.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(
          failure ??
            transaction.error ??
            new Error("Could not update the command outbox."),
        );
      transaction.onabort = () =>
        reject(
          failure ??
            transaction.error ??
            new Error("Could not update the command outbox."),
        );
    });
  } finally {
    database.close();
  }
}

function parseCommandSequenceState(value: unknown): CommandSequenceState {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return {
      lastAcknowledged: value,
      lastRevision: 0,
      revisionInitialized: false,
      retiredRevisionEpochs: [],
      stateVersion: 0,
    };
  }
  const record = asRecord(value);
  const lastAcknowledged = record?.lastAcknowledged;
  if (
    typeof lastAcknowledged !== "number" ||
    !Number.isSafeInteger(lastAcknowledged) ||
    lastAcknowledged < 0
  ) {
    return {
      lastAcknowledged: 0,
      lastRevision: 0,
      revisionInitialized: false,
      retiredRevisionEpochs: [],
      stateVersion: 0,
    };
  }
  const lastRevision =
    typeof record?.lastRevision === "number" &&
    Number.isSafeInteger(record.lastRevision) &&
    record.lastRevision >= 0
      ? record.lastRevision
      : 0;
  const revisionInitialized = record?.revisionInitialized === true;
  const stateVersion =
    typeof record?.stateVersion === "number" &&
    Number.isSafeInteger(record.stateVersion) &&
    record.stateVersion >= 0
      ? record.stateVersion
      : 0;
  const revisionEpoch =
    typeof record?.revisionEpoch === "string" && record.revisionEpoch
      ? record.revisionEpoch
      : undefined;
  const revisionEpochGeneration =
    typeof record?.revisionEpochGeneration === "number" &&
    Number.isSafeInteger(record.revisionEpochGeneration) &&
    record.revisionEpochGeneration > 0
      ? record.revisionEpochGeneration
      : undefined;
  const retiredRevisionEpochs = Array.isArray(record?.retiredRevisionEpochs)
    ? [
        ...new Set(
          record.retiredRevisionEpochs.filter(
            (value): value is string =>
              typeof value === "string" && value.length > 0,
          ),
        ),
      ]
    : [];
  const pending = asRecord(record?.pending);
  if (!pending) {
    return {
      lastAcknowledged,
      lastRevision,
      revisionInitialized,
      retiredRevisionEpochs,
      stateVersion,
      ...(revisionEpoch ? { revisionEpoch } : {}),
      ...(revisionEpochGeneration !== undefined
        ? { revisionEpochGeneration }
        : {}),
    };
  }
  if (
    typeof pending.commandId !== "string" ||
    typeof pending.sequence !== "number" ||
    !Number.isSafeInteger(pending.sequence) ||
    pending.sequence !== lastAcknowledged + 1 ||
    typeof pending.createdAt !== "number" ||
    !Number.isSafeInteger(pending.createdAt)
  ) {
    throw new Error("The persistent command outbox is corrupt.");
  }
  return {
    lastAcknowledged,
    lastRevision,
    revisionInitialized,
    retiredRevisionEpochs,
    stateVersion,
    ...(revisionEpoch ? { revisionEpoch } : {}),
    ...(revisionEpochGeneration !== undefined
      ? { revisionEpochGeneration }
      : {}),
    pending: {
      commandId: pending.commandId,
      sequence: pending.sequence,
      baseRevision:
        typeof pending.baseRevision === "number" &&
        Number.isSafeInteger(pending.baseRevision) &&
        pending.baseRevision >= 0
          ? pending.baseRevision
          : lastRevision,
      revisionEpoch:
        typeof pending.revisionEpoch === "string" && pending.revisionEpoch
          ? pending.revisionEpoch
          : revisionEpoch ?? "",
      createdAt: pending.createdAt,
      payload: pending.payload as CommandPayload,
      ...(asRecord(pending.plaintext)
        ? { plaintext: pending.plaintext as Record<string, unknown> }
        : {}),
    },
  };
}

function parseDurableGatewayEpochState(
  value: unknown,
): DurableGatewayEpochState | null {
  const record = asRecord(value);
  if (!record) return null;
  if (
    typeof record.revisionEpoch !== "string" ||
    !record.revisionEpoch ||
    !isPositiveInteger(record.revisionEpochGeneration) ||
    !isPositiveInteger(record.stateVersion) ||
    !isNonnegativeInteger(record.revision)
  ) {
    throw new Error("The durable Gateway epoch state is corrupt.");
  }
  return {
    revisionEpoch: record.revisionEpoch,
    revisionEpochGeneration: record.revisionEpochGeneration,
    stateVersion: record.stateVersion,
    revision: record.revision,
    retiredRevisionEpochs: Array.isArray(record.retiredRevisionEpochs)
      ? [
          ...new Set(
            record.retiredRevisionEpochs.filter(
              (entry): entry is string =>
                typeof entry === "string" && entry.length > 0,
            ),
          ),
        ]
      : [],
  };
}

function readIdentity(database: IDBDatabase): Promise<DeviceIdentity | null> {
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(DEVICE_STORE, "readonly")
      .objectStore(DEVICE_STORE)
      .get(DEVICE_KEY);
    request.onsuccess = () =>
      resolve((request.result as DeviceIdentity | undefined) ?? null);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not read the device key."));
  });
}

function writeIdentity(
  database: IDBDatabase,
  identity: DeviceIdentity,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DEVICE_STORE, "readwrite");
    transaction.objectStore(DEVICE_STORE).put(identity, DEVICE_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Could not save the device key."));
  });
}

function fallbackBody(payload: CommandPayload): string {
  switch (payload.operation) {
    case "prompt":
      return payload.text;
    case "cancel":
      return "Stop the current agent task";
    case "decision":
      return `Permission decision: ${payload.decision}`;
    case "session.settings":
      return "Update agent session settings";
    case "session.create":
      return "Create a new agent session";
    case "device.invite":
      return "Authorize a new Codever device";
  }
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function isNonnegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function humanizeField(value: string): string {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
