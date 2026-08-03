import {
  DEFAULT_HISTORY_PAGE_BYTES,
  CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE,
  MAX_CODEVER_ATTACHMENT_BYTES,
  attachmentSchema,
  gatewayStateRequestSchema,
  historyItemsSchema,
  historyPageSchema,
  historyRequestSchema,
  type CodeverAttachment,
  type CodeverCommand,
  type CommandPayload,
  type GatewayStateRequest,
  type HistoryBatch,
  type HistoryPage,
  type HistoryItem,
  type HistoryRequest,
  type JsonValue,
  type SignedCommand,
} from "@codever/protocol";
import {
  generateDeviceKeyPair,
  decryptMedia,
  encryptMedia,
  openSecureEnvelopeBundle,
  openSecureEnvelope,
  sealSecureEnvelope,
  SecurityError,
  sha256,
  signCommand,
  toArrayBuffer,
  type ReplayStore,
  verifyPairingRejection,
  verifyPairingResponse,
} from "@codever/security";
import type {
  Device,
  MatrixClient,
  MatrixEvent,
  MsgType,
  Room,
  RoomMessageEventContent,
} from "matrix-js-sdk";
import {
  applyGatewayDeviceRotation,
  applyGatewayTransportSnapshot,
  completePairing,
  loadTrustedGateway,
  PairingRejectedError,
  saveTrustedGateway,
  type PairingPreview,
  type PairingTransport,
  type TrustedGateway,
} from "./pairing";
import {
  CODEVER_GATEWAY_TRANSPORT_PROFILE_FIELD,
  signedGatewayDeviceRotationSchema,
  jsonValueSchema,
  signedPairingRejectionSchema,
  signedSecureEnvelopeBundleSchema,
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
  LateResponseLifecycle,
  createDetachedSerialDispatcher,
} from "./lateResponseLifecycle";
import {
  isValidPendingCommandSequence,
  retainsCommandUntilResultConsumed,
} from "./durableCommandRecovery";
import { advanceHistoryCursor } from "./historyCursor";
import {
  acquireMatrixCryptoLock,
  checkpointAndReleaseMatrixSyncStore,
  checkpointMatrixSyncStore,
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
import {
  legacyToolGroupPresentation,
  messageFormat,
  parseToolGroupPresentation,
  type MessageFormat,
  type ToolGroupPresentation,
} from "./presentation";
import {
  MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_DETAIL,
  MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_MS,
  MATRIX_CRYPTO_LOADING_DETAIL,
  MATRIX_SYNC_CHECKPOINT_RECOVERY_DETAIL,
  MATRIX_SYNC_CHECKPOINT_SAVE_DETAIL,
  matrixInitialSyncLimit,
  shouldRecoverMatrixSyncCheckpoint,
} from "./matrixStartup";
import { processMatrixEventWithDecryptionRetry } from "./matrixDecryptionRetry";
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
const LOCAL_STORE_TIMEOUT_MS = 10_000;
const DEVICE_KEYS_UPLOAD_TIMEOUT_MS = 30_000;
const GATEWAY_DEVICE_TIMEOUT_MS = 15_000;
const ENCRYPTED_SEND_TIMEOUT_MS = 20_000;
const HISTORY_REQUEST_TIMEOUT_MS = 30_000;
const HISTORY_BATCH_DOWNLOAD_TIMEOUT_MS = 60_000;
const HISTORY_REQUEST_EXPIRY_GRACE_MS = 5_000;

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
  completion?: CommandCompletion;
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
  operationId?: string;
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
  format: MessageFormat;
  toolGroup?: ToolGroupPresentation;
  attachments?: CodeverAttachment[];
  raw: Record<string, unknown>;
};

export type MatrixConnectionStatus =
  | "connecting"
  | "securing"
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

export type MatrixHistoryRecovery = MatrixHistoryPage & {
  sessionId: string;
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
  readonly ready: Promise<void>;
  readonly identity: DeviceIdentity;
  readonly matrixDeviceKeys: {
    ed25519: string;
    curve25519: string;
  };
  readonly deviceTransport: MatrixTransportBinding;
  pair(
    preview: PairingPreview,
    deviceName: string,
    signal?: AbortSignal,
  ): Promise<TrustedGateway>;
  send(payload: CommandPayload): Promise<CommandSendResult>;
  recoverCommand(commandId: string): Promise<CommandSendResult>;
  uploadAttachment(file: File): Promise<CodeverAttachment>;
  downloadAttachment(attachment: CodeverAttachment): Promise<Blob>;
  confirmRevisionRetry(commandId: string): Promise<CommandSendResult>;
  discardRevisionConflict(commandId: string): Promise<void>;
  markHistoryLoaded(sessionId: string, eventIds: readonly string[]): void;
  loadRecentHistory(
    sessionId: string,
    limit?: number,
  ): Promise<MatrixHistoryPage>;
  loadHistoryPage(sessionId: string, limit?: number): Promise<MatrixHistoryPage>;
  observeCommandCompletion(
    commandId: string,
    timeoutMs: number,
  ): Promise<CommandCompletion>;
  releaseCommand(commandId: string): Promise<void>;
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
    onHistoryRecovered?(page: MatrixHistoryRecovery): void;
  },
): Promise<MatrixConnection> {
  const config = normalizeMatrixConfig(configInput);
  handlers.onStatus("connecting", "Preparing this browser’s device identity…");
  const identity = await withMatrixTimeout(
    getOrCreateDeviceIdentity(),
    LOCAL_STORE_TIMEOUT_MS,
    "The browser device identity store did not open in time.",
  );
  let activeTrust = await loadTrustedGateway(identity);
  const replayStore = new IndexedDbReplayStore();
  const historyReplayStore = new DisplayOnlyReplayStore();
  const sdk = await import("matrix-js-sdk");
  const syncStoreDatabaseName = await matrixSyncDatabaseName(config);
  handlers.onStatus("connecting", "Opening the Matrix sync store…");
  await withMatrixTimeout(
    waitForMatrixSyncStoreClose(syncStoreDatabaseName),
    LOCAL_STORE_TIMEOUT_MS,
    "The Matrix sync store did not close its previous connection in time.",
  );
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
  let connectionReady = false;
  let refreshGatewayStateAfterReconnect = false;
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
  const gatewayHistoryState = new Map<
    string,
    { before?: string; complete: boolean }
  >();
  const pendingHistoryRequests = new Map<
    string,
    {
      sessionId: string;
      before?: string;
      messages: IncomingCodeverMessage[];
      page?: HistoryPage;
    }
  >();
  const historyRequestLifecycle = new LateResponseLifecycle<MatrixHistoryPage>(
    (requestId) => {
      pendingHistoryRequests.delete(requestId);
    },
  );
  let legacyHistorySessionHint: string | null = null;
  let historyInitialized = false;
  let historyChain: Promise<unknown> = Promise.resolve();
  const inFlightHistoryLoads = new Map<string, Promise<MatrixHistoryPage>>();
  const inFlightHistoryRequests = new Map<string, Promise<MatrixHistoryPage>>();
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
    const trust = activeTrust;
    if (trust) {
      await savePendingCommandCompletion(
        config,
        identity,
        trust.certificate.certificate.certificateId,
        result,
      );
    }
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
  const requestGatewayStateSnapshot = async (): Promise<void> => {
    assertPersistenceHealthy();
    const trust = activeTrust;
    if (!trust) return;
    const certificate = trust.certificate.certificate;
    const now = Date.now();
    const request: GatewayStateRequest = gatewayStateRequestSchema.parse({
      kind: "codever.gateway.state.request",
      version: 1,
      requestId: crypto.randomUUID(),
      gatewayId: trust.gatewayId,
      conversationId: config.conversationId,
      deviceId: certificate.deviceId,
      issuedAt: now,
      expiresAt: now + 60_000,
    });
    const plaintext = {
      msgtype: sdk.MsgType.Notice,
      body: "Encrypted Codever gateway state request",
      "io.codever": {
        version: 1,
        kind: "gateway_state_request",
        gateway_state_request: request,
      },
    } as const;
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
    await client.sendMessage(
      config.roomId,
      {
        msgtype: sdk.MsgType.Notice,
        body: "Encrypted Codever message",
        "io.codever": {
          version: 1,
          kind: "secure_envelope",
          secure_envelope: secureEnvelope,
        },
      } as unknown as RoomMessageEventContent,
      `codever.gateway.state.request.${request.requestId}`,
    );
  };
  const reportInboundError = (error: unknown) => {
    handlers.onStatus("error", formatError(error));
  };
  const resolveHistoryRequest = (
    requestId: string,
    page: MatrixHistoryPage,
  ): void => {
    const pending = pendingHistoryRequests.get(requestId);
    if (!pending) return;
    pendingHistoryRequests.delete(requestId);
    const delivery = historyRequestLifecycle.resolve(requestId, page);
    if (delivery?.late && delivery.activeWaiters === 0) {
      handlers.onHistoryRecovered?.({
        sessionId: pending.sessionId,
        ...page,
      });
    }
  };
  const rejectHistoryRequest = (requestId: string, error: Error): void => {
    pendingHistoryRequests.delete(requestId);
    historyRequestLifecycle.reject(requestId, error);
  };
  const finishHistoryRequest = (requestId: string): void => {
    const pending = pendingHistoryRequests.get(requestId);
    const page = pending?.page;
    if (!pending || !page || pending.messages.length < page.replayed) return;
    advanceGatewayHistoryCursor(pending, page);
    pending.messages.sort(compareIncomingMessages);
    resolveHistoryRequest(requestId, {
      messages: pending.messages,
      hasMore: page.hasMore,
    });
  };
  const onHistoryReplay = (
    requestId: string,
    message: IncomingCodeverMessage,
  ): boolean => {
    const pending = pendingHistoryRequests.get(requestId);
    if (!pending || message.sessionId !== pending.sessionId) return false;
    if (!pending.messages.some((candidate) => candidate.eventId === message.eventId)) {
      pending.messages.push(message);
    }
    finishHistoryRequest(requestId);
    return true;
  };
  const onHistoryPage = async (page: HistoryPage): Promise<void> => {
    const pending = pendingHistoryRequests.get(page.requestId);
    if (!pending) return;
    if (pending.sessionId !== page.sessionId) {
      rejectHistoryRequest(
        page.requestId,
        new Error("Gateway history response targeted the wrong session."),
      );
      return;
    }
    // Once an authenticated response arrives, retain it for the bounded media
    // download even if the original request's protocol expiry is near.
    historyRequestLifecycle.extend(
      page.requestId,
      Date.now() + HISTORY_BATCH_DOWNLOAD_TIMEOUT_MS,
    );
    let items: HistoryItem[] | null;
    try {
      items = await withMatrixTimeout(
        historyItemsFromPage(page, client),
        HISTORY_BATCH_DOWNLOAD_TIMEOUT_MS,
        "The encrypted history page could not be downloaded in time.",
      );
    } catch (error) {
      rejectHistoryRequest(
        page.requestId,
        error instanceof Error ? error : new Error(formatError(error)),
      );
      return;
    }
    if (items) {
      try {
        const messages = items.map((item) => {
          const replay = parseHistoryReplayEvent(
            item.eventId,
            config.gatewayId,
            item.timestamp,
            withHistoryReplayMarker(item.content, page.requestId, item.timestamp),
          );
          if (!replay || replay.message.sessionId !== pending.sessionId) {
            throw new Error("Gateway history page contained an invalid session item.");
          }
          return replay.message;
        });
        advanceGatewayHistoryCursor(pending, page);
        resolveHistoryRequest(page.requestId, {
          messages: deduplicateHistoryMessages(messages).sort(compareIncomingMessages),
          hasMore: page.hasMore,
        });
      } catch (error) {
        rejectHistoryRequest(
          page.requestId,
          error instanceof Error ? error : new Error(formatError(error)),
        );
      }
      return;
    }
    pending.page = page;
    finishHistoryRequest(page.requestId);
  };
  const advanceGatewayHistoryCursor = (
    pending: { sessionId: string; before?: string },
    page: HistoryPage,
  ): void => {
    const current = gatewayHistoryState.get(pending.sessionId);
    const next = advanceHistoryCursor(current, pending.before, {
      ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
      hasMore: page.hasMore,
    });
    if (next !== current) gatewayHistoryState.set(page.sessionId, next!);
  };
  const dispatchHistoryPage = createDetachedSerialDispatcher(
    onHistoryPage,
    reportInboundError,
  );
  const processInboundEvent = (
    event: MatrixEvent,
    historical: boolean,
  ): Promise<void> =>
    processMatrixEventWithDecryptionRetry(
      event,
      sdk.MatrixEventEvent.Decrypted,
      (candidate) =>
        processGatewayTimelineEvent(
          client,
          candidate,
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
          onHistoryReplay,
          dispatchHistoryPage,
          historical,
        ),
      reportInboundError,
    );
  let inboundChain: Promise<void> = Promise.resolve();
  const enqueueInboundEvent = (
    event: MatrixEvent,
    historical: boolean,
  ): Promise<void> => {
    const operation = inboundChain.then(() =>
      processInboundEvent(event, historical),
    );
    // A rejected live event is reported by its caller but must not poison the
    // queue. Serial processing ensures every rotation observes the trust state
    // persisted by the preceding snapshot or rotation.
    inboundChain = operation.catch(() => undefined);
    return operation;
  };
  const onTimeline = (
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline: boolean | undefined,
  ) => {
    if (stopped || !room || room.roomId !== config.roomId || toStartOfTimeline) {
      return;
    }
    void enqueueInboundEvent(event, !initialSyncComplete).catch(
      reportInboundError,
    );
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
      if (connectionReady && refreshGatewayStateAfterReconnect) {
        refreshGatewayStateAfterReconnect = false;
        void requestGatewayStateSnapshot().catch((error) => {
          refreshGatewayStateAfterReconnect = true;
          reportInboundError(error);
        });
      }
      if (connectionReady) handlers.onStatus("connected");
    } else if (state === "RECONNECTING" || state === "CATCHUP") {
      refreshGatewayStateAfterReconnect = true;
      handlers.onStatus("reconnecting");
    } else if (state === "ERROR") {
      handlers.onStatus("error", "Matrix sync failed. Check the token and server.");
    } else if (state === "STOPPED") {
      handlers.onStatus("offline");
    }
  };

  let recoveringSyncCheckpoint = false;
  let startupRoom: Room | null = null;
  handlers.onStatus("connecting", "Opening the encrypted device store…");
  try {
    // SDK 41 assigns the store's user factory during createClient, so startup
    // must happen after createClient({ store }) and before the first /sync.
    await withMatrixTimeout(
      syncStore.startup(),
      LOCAL_STORE_TIMEOUT_MS,
      "The Matrix sync database did not open in time.",
    );
    const savedSyncToken = await syncStore.getSavedSyncToken();
    recoveringSyncCheckpoint = shouldRecoverMatrixSyncCheckpoint(
      Boolean(activeTrust),
      savedSyncToken,
    );
    assertPersistenceHealthy();
    handlers.onStatus(
      "connecting",
      MATRIX_CRYPTO_LOADING_DETAIL,
    );
    await withMatrixTimeout(
      client.initRustCrypto({
        useIndexedDB: true,
        cryptoDatabasePrefix: cryptoStoreScope,
      }),
      MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_MS,
      MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_DETAIL,
    );
    const cryptoApi = client.getCrypto();
    if (!cryptoApi) {
      throw new Error("Matrix Rust crypto did not initialize.");
    }
    const { AllDevicesIsolationMode } = await import(
      "matrix-js-sdk/lib/crypto-api"
    );
    cryptoApi.globalBlacklistUnverifiedDevices = true;
    cryptoApi.setDeviceIsolationMode(new AllDevicesIsolationMode(false));
    matrixDeviceKeys = await withMatrixTimeout(
      cryptoApi.getOwnDeviceKeys(),
      LOCAL_STORE_TIMEOUT_MS,
      "Matrix did not create this device’s encryption keys in time.",
    );
    if (!matrixDeviceKeys) {
      throw new Error("Matrix device keys were not initialized.");
    }
    client.on(sdk.ClientEvent.Sync, onSync);
    handlers.onStatus(
      "connecting",
      recoveringSyncCheckpoint
        ? MATRIX_SYNC_CHECKPOINT_RECOVERY_DETAIL
        : "Starting the first encrypted sync…",
    );
    await client.startClient({
      initialSyncLimit: matrixInitialSyncLimit(
        Boolean(activeTrust),
        recoveringSyncCheckpoint,
      ),
    });
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
    startupRoom = room;
    handlers.onStatus(
      "securing",
      activeTrust
        ? "Matrix connected. Verifying the trusted Gateway and restoring its current state…"
        : "Matrix connected. Preparing secure pairing…",
    );
  } catch (error) {
    stopped = true;
    client.off(sdk.RoomEvent.Timeline, onTimeline);
    client.off(sdk.ClientEvent.Sync, onSync);
    client.stopClient();
    let detail = formatError(error);
    try {
      await withMatrixTimeout(
        checkpointAndReleaseMatrixSyncStore(
          syncStoreDatabaseName,
          syncStore,
          cryptoLock,
        ),
        LOCAL_STORE_TIMEOUT_MS,
        "Timed out while closing the Matrix stores.",
      );
    } catch (cleanupError) {
      await cryptoLock.release().catch(() => undefined);
      detail = `${detail} The local Matrix stores could not be checkpointed or closed cleanly: ${formatError(
        cleanupError,
      )} Reload this page before retrying.`;
    }
    handlers.onStatus("error", detail);
    throw new Error(detail);
  }
  if (!matrixDeviceKeys) {
    await checkpointAndReleaseMatrixSyncStore(
      syncStoreDatabaseName,
      syncStore,
      cryptoLock,
    );
    throw new Error("Matrix device keys were not initialized.");
  }
  if (!startupRoom) {
    await checkpointAndReleaseMatrixSyncStore(
      syncStoreDatabaseName,
      syncStore,
      cryptoLock,
    );
    throw new Error("The encrypted Matrix room was not initialized.");
  }

  let ownMatrixDeviceKeysPublished: Promise<void> | null = null;
  const ensureOwnMatrixDeviceKeysPublished = (): Promise<void> => {
    ownMatrixDeviceKeysPublished ??= waitForOwnMatrixDeviceKeys(
      config,
      matrixDeviceKeys,
      DEVICE_KEYS_UPLOAD_TIMEOUT_MS,
    );
    return ownMatrixDeviceKeysPublished;
  };
  const assertStartupActive = (): void => {
    if (stopped) throw new Error("Matrix connection closed during startup.");
  };
  const finishMatrixStartup = async (): Promise<void> => {
    assertStartupActive();
    let gatewayTransportChanged = false;
    if (activeTrust) {
      handlers.onStatus(
        "securing",
        "Checking the durable Gateway recovery profile…",
      );
      const recoveredTrust = await withMatrixTimeout(
        recoverGatewayTransportSnapshot(client, config, activeTrust),
        GATEWAY_DEVICE_TIMEOUT_MS,
        "The Gateway recovery profile could not be checked in time.",
      );
      assertStartupActive();
      if (recoveredTrust !== activeTrust) {
        gatewayTransportChanged = true;
        activeTrust = recoveredTrust;
        handlers.onTrustUpdated?.(recoveredTrust);
      }
    }
    const configuredGateway = activeTrust?.gatewayTransport ?? gatewayPin(config);
    if (configuredGateway && activeTrust) {
      if (!gatewayTransportChanged) {
        handlers.onStatus("securing", "Verifying the trusted Gateway device…");
        await withMatrixTimeout(
          verifyAndPinGatewayDevice(client, configuredGateway),
          GATEWAY_DEVICE_TIMEOUT_MS,
          "The trusted Gateway device could not be verified in time.",
        );
        assertStartupActive();
      }
      if (gatewayTransportChanged) {
        handlers.onStatus(
          "securing",
          "Preparing encryption for the recovered Gateway device…",
        );
        const cryptoApi = client.getCrypto();
        if (!cryptoApi) {
          throw new Error("Matrix encryption is not ready.");
        }
        await withMatrixTimeout(
          cryptoApi.forceDiscardSession(config.roomId),
          LOCAL_STORE_TIMEOUT_MS,
          "The recovered Gateway encryption session could not be prepared in time.",
        );
        assertStartupActive();
      }
    }

    if (recoveringSyncCheckpoint) {
      handlers.onStatus("securing", MATRIX_SYNC_CHECKPOINT_SAVE_DETAIL);
      await withMatrixTimeout(
        checkpointMatrixSyncStore(syncStoreDatabaseName, syncStore),
        LOCAL_STORE_TIMEOUT_MS,
        "The rebuilt Matrix sync checkpoint could not be saved in time.",
      );
      assertStartupActive();
      if (!(await syncStore.getSavedSyncToken())) {
        throw new Error(
          "The Matrix sync checkpoint was rebuilt but could not be persisted. Check this browser’s storage settings and try again.",
        );
      }
    }

    // Take the complete timeline snapshot and install the live listener in the
    // same turn. Events received while Gateway verification was running are in
    // this snapshot; later events are serialized behind it without a gap.
    const initialTimeline = [...startupRoom.getLiveTimeline().getEvents()];
    const initialTimelineOperations = initialTimeline.map((event) =>
      enqueueInboundEvent(event, true),
    );
    client.on(sdk.RoomEvent.Timeline, onTimeline);
    await Promise.all(initialTimelineOperations);
    assertStartupActive();

    if (activeTrust) {
      const cachedGatewayState = await loadCachedGatewayState(
        config,
        identity,
        activeTrust.certificate.certificate.certificateId,
      );
      assertStartupActive();
      if (cachedGatewayState) {
        handlers.onCollaborationState?.({
          revision: cachedGatewayState.revision,
          activeDeviceCount: cachedGatewayState.activeDeviceCount,
          gatewayState: cachedGatewayState,
        });
      }
      handlers.onStatus(
        "securing",
        "Refreshing the current Gateway session list…",
      );
      await requestGatewayStateSnapshot();
      assertStartupActive();
    }

    assertPersistenceHealthy();
    connectionReady = true;
    handlers.onStatus("connected");
  };
  const startupReady = finishMatrixStartup();
  void startupReady.catch(async (error) => {
    if (stopped) return;
    stopped = true;
    historyRequestLifecycle.close(
      new Error("Matrix connection closed during secure startup."),
    );
    pendingHistoryRequests.clear();
    client.off(sdk.RoomEvent.Timeline, onTimeline);
    client.off(sdk.ClientEvent.Sync, onSync);
    client.stopClient();
    let detail = formatError(error);
    try {
      await withMatrixTimeout(
        checkpointAndReleaseMatrixSyncStore(
          syncStoreDatabaseName,
          syncStore,
          cryptoLock,
        ),
        LOCAL_STORE_TIMEOUT_MS,
        "Timed out while closing the Matrix stores.",
      );
    } catch (cleanupError) {
      await cryptoLock.release().catch(() => undefined);
      detail = `${detail} The local Matrix stores could not be closed cleanly: ${formatError(
        cleanupError,
      )} Reload this page before retrying.`;
    }
    handlers.onStatus("error", detail);
  });
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
    await startupReady;
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
      if (recovered.completion) {
        commandLifecycle.recordResult(recovered.completion);
        if (JSON.stringify(recovered.payload) === JSON.stringify(payload)) {
          return {
            eventId: recovered.eventId,
            commandId: recovered.reservation.commandId,
            sequence: recovered.reservation.sequence,
            revision: recovered.completion.revision,
            completion: Promise.resolve(recovered.completion),
          };
        }
        await discardPendingCommand(
          config,
          identity,
          sequenceEpoch,
          recovered.reservation.commandId,
        );
        commandLifecycle.release(recovered.reservation.commandId);
      } else {
        try {
          const revision = await waitForCommandAcknowledgement(
            recovered.reservation,
          );
          const samePayload =
            JSON.stringify(recovered.payload) === JSON.stringify(payload);
          if (
            (!recovered.expired ||
              retainsCommandUntilResultConsumed(recovered.payload)) &&
            samePayload
          ) {
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
          if (retainsCommandUntilResultConsumed(recovered.payload)) {
            await commandLifecycle.waitForCompletion(
              recovered.reservation.commandId,
              COMMAND_TTL_MS,
            );
            await discardPendingCommand(
              config,
              identity,
              sequenceEpoch,
              recovered.reservation.commandId,
            );
            commandLifecycle.release(recovered.reservation.commandId);
          }
          // An expired ordinary command is replayed only to repair its
          // durable sequence. A recoverable invitation additionally waits for
          // its terminal result before allowing a different command through.
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
  const recoverCommand = async (
    commandId: string,
  ): Promise<CommandSendResult> => {
    await startupReady;
    if (stopped) throw new Error("Matrix connection is closed.");
    assertPersistenceHealthy();
    const trust = activeTrust;
    if (!trust) {
      throw new Error(
        "Pair and verify the Gateway application key before recovering a command.",
      );
    }
    if (!client.isRoomEncrypted(config.roomId)) {
      throw new Error("Refusing to recover through an unencrypted Matrix room.");
    }
    if (pendingRevisionConflict) {
      throw new CommandRevisionConflictError(
        pendingRevisionConflict.reservation.commandId,
        pendingRevisionConflict.expectedRevision,
        pendingRevisionConflict.payload,
      );
    }
    const sequenceEpoch = trust.certificate.certificate.certificateId;
    await assertRevisionInitialized(config, identity, sequenceEpoch);
    const recovered = await retryPendingCommand(
      client,
      config,
      identity,
      sequenceEpoch,
      trust,
      commandId,
    );
    if (!recovered) {
      throw new Error(
        `The durable command ${commandId} is no longer available for recovery.`,
      );
    }
    if (recovered.completion) {
      commandLifecycle.recordResult(recovered.completion);
      return {
        eventId: recovered.eventId,
        commandId: recovered.reservation.commandId,
        sequence: recovered.reservation.sequence,
        revision: recovered.completion.revision,
        completion: Promise.resolve(recovered.completion),
      };
    }
    try {
      const revision = await waitForCommandAcknowledgement(
        recovered.reservation,
      );
      return {
        eventId: recovered.eventId,
        commandId: recovered.reservation.commandId,
        sequence: recovered.reservation.sequence,
        revision,
        completion: commandLifecycle.waitForCompletion(
          recovered.reservation.commandId,
        ),
      };
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error;
      return holdRevisionConflict(
        error,
        recovered.reservation,
        recovered.payload,
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
  const performGatewayHistoryPage = async (
    sessionId: string,
    limit: number,
    key: string,
  ): Promise<MatrixHistoryPage> => {
    if (stopped) throw new Error("Matrix connection is closed.");
    assertPersistenceHealthy();
    const trust = activeTrust;
    if (!trust) {
      throw new Error("Pair and verify the Gateway before restoring history.");
    }
    const state = gatewayHistoryState.get(sessionId);
    if (state?.complete) return { messages: [], hasMore: false };
    if (!client.isRoomEncrypted(config.roomId)) {
      throw new Error("Refusing to request history from an unencrypted Matrix room.");
    }
    const now = Date.now();
    const request: HistoryRequest = historyRequestSchema.parse({
      kind: "codever.history.request",
      version: 1,
      requestId: crypto.randomUUID(),
      gatewayId: trust.gatewayId,
      conversationId: config.conversationId,
      deviceId: trust.certificate.certificate.deviceId,
      sessionId,
      ...(state?.before ? { before: state.before } : {}),
      limit: Math.max(1, Math.min(limit, 100)),
      maxBytes: DEFAULT_HISTORY_PAGE_BYTES,
      issuedAt: now,
      expiresAt: now + 60_000,
    });
    pendingHistoryRequests.set(request.requestId, {
      sessionId,
      ...(state?.before ? { before: state.before } : {}),
      messages: [],
    });
    historyRequestLifecycle.register(
      request.requestId,
      key,
      request.expiresAt + HISTORY_REQUEST_EXPIRY_GRACE_MS,
    );
    const response = historyRequestLifecycle.wait(
      request.requestId,
      HISTORY_REQUEST_TIMEOUT_MS,
      () =>
        new Error(
          "The Gateway is still preparing this history page. Retry to keep waiting for the same request.",
        ),
    );
    try {
      const certificate = trust.certificate.certificate;
      const plaintext = {
        msgtype: sdk.MsgType.Notice,
        body: "Encrypted Codever history request",
        "io.codever": {
          version: 1,
          kind: "history_request",
          history_request: request,
        },
      } as const;
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
      await client.sendMessage(
        config.roomId,
        {
          msgtype: sdk.MsgType.Notice,
          body: "Encrypted Codever message",
          "io.codever": {
            version: 1,
            kind: "secure_envelope",
            secure_envelope: secureEnvelope,
          },
        } as unknown as RoomMessageEventContent,
        `codever.history.request.${request.requestId}`,
      );
    } catch (error) {
      rejectHistoryRequest(
        request.requestId,
        error instanceof Error ? error : new Error(formatError(error)),
      );
    }
    return response;
  };
  const requestGatewayHistoryPage = (
    sessionId: string,
    limit: number,
  ): Promise<MatrixHistoryPage> => {
    const state = gatewayHistoryState.get(sessionId);
    const key = `${sessionId}\u0000${state?.before ?? "latest"}`;
    const pendingRequestId = historyRequestLifecycle.idForKey(key);
    if (pendingRequestId) {
      return historyRequestLifecycle.wait(
        pendingRequestId,
        HISTORY_REQUEST_TIMEOUT_MS,
        () =>
          new Error(
            "The Gateway is still preparing this history page. Retry to keep waiting for the same request.",
          ),
      );
    }
    const existing = inFlightHistoryRequests.get(key);
    if (existing) return existing;
    const operation = performGatewayHistoryPage(sessionId, limit, key);
    inFlightHistoryRequests.set(key, operation);
    return operation.finally(() => {
      if (inFlightHistoryRequests.get(key) === operation) {
        inFlightHistoryRequests.delete(key);
      }
    });
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
    await startupReady;
    if (stopped) throw new Error("Matrix connection is closed.");
    const room = client.getRoom(config.roomId);
    if (!room) throw new Error("The Matrix room is not available.");
    const pageLimit = Math.max(1, Math.min(limit, 100));
    await scanHistoryTimeline(room, sessionId);
    const local = takeHistory(sessionId, pageLimit);
    const gateway = await requestGatewayHistoryPage(sessionId, pageLimit);
    const messages = deduplicateIncomingMessages([
      ...local,
      ...gateway.messages,
    ]).sort(compareIncomingMessages);
    return {
      messages,
      hasMore: hasPendingHistory(sessionId) || gateway.hasMore,
    };
  };
  const loadRecentHistory = async (
    sessionId: string,
    limit = 30,
  ): Promise<MatrixHistoryPage> => {
    await startupReady;
    if (stopped) throw new Error("Matrix connection is closed.");
    const room = client.getRoom(config.roomId);
    if (!room) throw new Error("The Matrix room is not available.");
    const pageLimit = Math.max(1, Math.min(limit, 100));
    await scanHistoryTimeline(room, sessionId);
    const local = takeHistory(sessionId, pageLimit);
    const gateway = await requestGatewayHistoryPage(sessionId, pageLimit);
    return {
      messages: deduplicateIncomingMessages([
        ...local,
        ...gateway.messages,
      ]).sort(compareIncomingMessages),
      hasMore: hasPendingHistory(sessionId) || gateway.hasMore,
    };
  };
  const enqueueHistoryOperation = (
    sessionId: string,
    limit: number,
    operation: () => Promise<MatrixHistoryPage>,
  ): Promise<MatrixHistoryPage> => {
    const state = gatewayHistoryState.get(sessionId);
    const key = `${sessionId}\u0000${state?.before ?? "latest"}\u0000${limit}`;
    const existing = inFlightHistoryLoads.get(key);
    if (existing) return existing;
    const queued = historyChain.then(operation);
    historyChain = queued.then(
      () => undefined,
      () => undefined,
    );
    inFlightHistoryLoads.set(key, queued);
    return queued.finally(() => {
      if (inFlightHistoryLoads.get(key) === queued) {
        inFlightHistoryLoads.delete(key);
      }
    });
  };
  const uploadAttachment = async (file: File): Promise<CodeverAttachment> => {
    await startupReady;
    if (stopped) throw new Error("Matrix connection is closed.");
    assertPersistenceHealthy();
    if (!client.isRoomEncrypted(config.roomId)) {
      throw new Error("Refusing to upload an attachment for an unencrypted Matrix room.");
    }
    if (!file.name || file.name.length > 1_024) {
      throw new Error("Attachment name must contain between 1 and 1024 characters.");
    }
    if (file.size > MAX_CODEVER_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachment exceeds the ${formatByteCount(MAX_CODEVER_ATTACHMENT_BYTES)} limit.`,
      );
    }
    const plaintext = new Uint8Array(await file.arrayBuffer());
    const encrypted = await encryptMedia(plaintext);
    const uploaded = await client.uploadContent(
      new Blob([toArrayBuffer(encrypted.ciphertext)], { type: "application/octet-stream" }),
      {
        type: "application/octet-stream",
        includeFilename: false,
      },
    );
    return attachmentSchema.parse({
      id: crypto.randomUUID(),
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: plaintext.byteLength,
      sha256: await sha256(plaintext),
      media: {
        url: uploaded.content_uri,
        ...encrypted.descriptor,
      },
    });
  };
  const downloadAttachment = async (
    input: CodeverAttachment,
  ): Promise<Blob> => {
    await startupReady;
    if (stopped) throw new Error("Matrix connection is closed.");
    const attachment = attachmentSchema.parse(input);
    const url = client.mxcUrlToHttp(
      attachment.media.url,
      undefined,
      undefined,
      undefined,
      false,
      false,
      true,
    );
    if (!url) throw new Error("Matrix media URL could not be resolved.");
    const accessToken = client.getAccessToken();
    if (!accessToken) {
      throw new Error("Matrix access token is unavailable for media download.");
    }
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`Matrix media download failed with HTTP ${response.status}.`);
    }
    const declaredSize = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredSize) &&
      declaredSize > attachment.media.size
    ) {
      throw new Error("Encrypted attachment is larger than its signed metadata.");
    }
    const ciphertext = await readBoundedResponse(
      response,
      attachment.media.size,
    );
    const plaintext = await decryptMedia(ciphertext, attachment.media);
    if (
      plaintext.byteLength !== attachment.size ||
      (await sha256(plaintext)) !== attachment.sha256
    ) {
      throw new Error("Attachment content does not match its signed metadata.");
    }
    return new Blob([toArrayBuffer(plaintext)], { type: attachment.mimeType });
  };
  return {
    ready: startupReady,
    identity,
    matrixDeviceKeys,
    deviceTransport: {
      homeserver: config.homeserver,
      roomId: config.roomId,
      userId: config.userId,
      deviceId: config.matrixDeviceId,
      ed25519: matrixDeviceKeys.ed25519,
    },
    async pair(preview, deviceName, signal) {
      await startupReady;
      if (stopped) throw new Error("Matrix connection is closed.");
      assertPersistenceHealthy();
      handlers.onStatus("connected", "Publishing this device’s encryption keys…");
      await ensureOwnMatrixDeviceKeysPublished();
      const offerTransport = preview.transport;
      assertMatchingPairingRoute(config, offerTransport);
      handlers.onStatus("connected", "Verifying the Gateway device…");
      await withMatrixTimeout(
        verifyAndPinGatewayDevice(client, offerTransport),
        GATEWAY_DEVICE_TIMEOUT_MS,
        "The Gateway Matrix device could not be verified in time.",
      );
      handlers.onStatus("connected", "Preparing the encrypted pairing request…");
      await withMatrixTimeout(
        client.getCrypto()?.forceDiscardSession(config.roomId) ??
          Promise.resolve(),
        LOCAL_STORE_TIMEOUT_MS,
        "The encrypted pairing session could not be prepared in time.",
      );
      const transport = createMatrixPairingTransport(
        client,
        sdk.RoomEvent.Timeline,
        sdk.MsgType.Notice,
        config.roomId,
        (detail) => handlers.onStatus("connected", detail),
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
      handlers.onStatus("connected");
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
    recoverCommand(commandId) {
      const operation = outboundChain.then(() => recoverCommand(commandId));
      outboundChain = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    uploadAttachment,
    downloadAttachment,
    confirmRevisionRetry(commandId) {
      const operation = outboundChain.then(async () => {
        await startupReady;
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
        await startupReady;
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
      const pageLimit = Math.max(1, Math.min(limit ?? 30, 100));
      return enqueueHistoryOperation(sessionId, pageLimit, () =>
        loadRecentHistory(sessionId, pageLimit),
      );
    },
    loadHistoryPage(sessionId, limit) {
      const pageLimit = Math.max(1, Math.min(limit ?? 30, 100));
      return enqueueHistoryOperation(sessionId, pageLimit, () =>
        loadHistoryPage(sessionId, pageLimit),
      );
    },
    observeCommandCompletion(commandId, timeoutMs) {
      return commandLifecycle.waitForCompletion(commandId, timeoutMs);
    },
    async releaseCommand(commandId) {
      await startupReady;
      commandLifecycle.release(commandId);
      const trust = activeTrust;
      if (!trust) return;
      try {
        await discardPendingCommand(
          config,
          identity,
          trust.certificate.certificate.certificateId,
          commandId,
        );
      } catch (error) {
        handlers.onStatus(
          "error",
          `The completed command could not be released from the durable outbox: ${formatError(error)}`,
        );
        throw error;
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      historyRequestLifecycle.close(
        new Error("Matrix connection closed during history recovery."),
      );
      pendingHistoryRequests.clear();
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
  onProgress?: (detail: string) => void,
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
        onProgress?.("Sending the encrypted pairing request…");
        await withMatrixTimeout(
          client.sendMessage(
            roomId,
            content,
            `codever.pair.${request.request.requestId}.${crypto.randomUUID()}`,
          ),
          ENCRYPTED_SEND_TIMEOUT_MS,
          "The encrypted pairing request could not be sent in time.",
        );
        onProgress?.("Waiting for the Gateway to approve this device…");
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
        if (extension?.kind === "pairing_rejection") {
          const candidate = extension.pairing_rejection;
          if (!candidate) return;
          try {
            const parsed = signedPairingRejectionSchema.parse(candidate);
            if (
              parsed.rejection.offerId !== offer.offer.offerId ||
              parsed.rejection.requestId !== request.request.requestId
            ) {
              return;
            }
            const rejection = await verifyPairingRejection(
              parsed,
              offer,
              request,
            );
            finish({
              error: new PairingRejectedError(
                rejection.message,
                rejection.code,
                rejection.retryable,
              ),
            });
          } catch {
            // Only the pinned Gateway application key may reject pairing.
          }
          return;
        }
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
  // Returning devices should already be present in the persisted Rust crypto
  // store. Verify that local record first so an ordinary reconnect does not
  // add a network key query to the startup critical path.
  const localDevices = await cryptoApi.getUserDeviceInfo([gateway.userId], false);
  let device: Device | undefined = localDevices
    .get(gateway.userId)
    ?.get(gateway.deviceId);
  // A newly logged-in Gateway device can appear in /keys/query before the
  // Rust crypto store has processed the corresponding /sync device-list
  // change. Keep the client syncing briefly instead of making the user retry.
  const deadline = Date.now() + 10_000;
  while (!device && Date.now() < deadline) {
    const devices = await cryptoApi.getUserDeviceInfo([gateway.userId], true);
    device = devices.get(gateway.userId)?.get(gateway.deviceId);
    if (device) break;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
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

async function waitForOwnMatrixDeviceKeys(
  config: MatrixConnectionConfig,
  expected: { ed25519: string; curve25519: string },
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    const remaining = Math.max(1, deadline - Date.now());
    let published:
      | { ed25519: unknown; curve25519: unknown }
      | undefined;
    try {
      const response = await fetch(
        `${config.homeserver}/_matrix/client/v3/keys/query`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            device_keys: { [config.userId]: [config.matrixDeviceId] },
          }),
          signal: AbortSignal.timeout(Math.min(5_000, remaining)),
        },
      );
      if (!response.ok) {
        throw new Error(`Matrix key query failed with HTTP ${response.status}.`);
      }
      const result = asRecord(await response.json());
      const users = asRecord(result?.device_keys);
      const devices = asRecord(users?.[config.userId]);
      const device = asRecord(devices?.[config.matrixDeviceId]);
      const keys = asRecord(device?.keys);
      published = {
        ed25519: keys?.[`ed25519:${config.matrixDeviceId}`],
        curve25519: keys?.[`curve25519:${config.matrixDeviceId}`],
      };
    } catch (error) {
      lastError = error;
    }
    if (
      typeof published?.ed25519 === "string" ||
      typeof published?.curve25519 === "string"
    ) {
      if (
        published.ed25519 !== expected.ed25519 ||
        published.curve25519 !== expected.curve25519
      ) {
        throw new Error(
          "Matrix published different encryption keys for this device. Scan a new invitation to create a fresh Matrix device.",
        );
      }
      return;
    }
    if (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  } while (Date.now() < deadline);
  throw new Error(
    `This device did not publish its Matrix encryption keys in time.${
      lastError ? ` ${formatError(lastError)}` : ""
    }`,
  );
}

function withMatrixTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    operation.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
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
  if (
    typeof effectiveExtension.logical_event_id === "string" &&
    effectiveExtension.logical_event_id
  ) {
    eventId = effectiveExtension.logical_event_id;
  }
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
    ...(typeof effectiveExtension.operation_id === "string" &&
    effectiveExtension.operation_id
      ? { operationId: effectiveExtension.operation_id }
      : {}),
  };
  const replacementEventId =
    typeof effectiveExtension.replaces_logical_event_id === "string" &&
    effectiveExtension.replaces_logical_event_id
      ? effectiveExtension.replaces_logical_event_id
      : typeof relation?.event_id === "string"
        ? relation.event_id
        : undefined;
  const replacementMetadata = replacementEventId
    ? { replacesEventId: replacementEventId }
    : {};

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
      format: "plain",
      commandId: effectiveExtension.command_id,
      revision: effectiveExtension.revision,
      originDeviceId: effectiveExtension.origin_device_id,
      originDeviceName: effectiveExtension.origin_device_name,
      attachments: parseAttachments(effectiveExtension.attachments),
      ...(isPositiveInteger(effectiveExtension.active_device_count)
        ? { activeDeviceCount: effectiveExtension.active_device_count }
        : {}),
      raw: effectiveExtension,
    };
  }
  if (effectiveExtension.kind === "message") {
    const ui = asRecord(effectiveExtension.ui);
    const toolGroup =
      parseToolGroupPresentation(ui) ??
      (ui?.kind === "tool_card"
        ? legacyToolGroupPresentation({
            groupId: eventId,
            name: body || "Agent tool",
            timestamp,
          })
        : undefined);
    return {
      eventId,
      sender,
      timestamp,
      encrypted,
      ...collaborationMetadata,
      kind: toolGroup ? "tool" : "agent",
      text: body,
      format: messageFormat(effectiveExtension.format),
      ...(toolGroup ? { toolGroup } : {}),
      attachments: parseAttachments(effectiveExtension.attachments),
      ...replacementMetadata,
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
      format: "plain",
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
      format: "plain",
      ...replacementMetadata,
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
    ...replacementMetadata,
    raw: payload,
  };

  switch (payload.type) {
    case "agent.text.delta":
    case "agent.text.completed":
      return {
        ...common,
        kind: "agent",
        text: typeof payload.text === "string" ? payload.text : "",
        format: "markdown",
        ...(typeof payload.streamId === "string"
          ? { streamId: payload.streamId }
          : {}),
      };
    case "agent.tool.started":
    case "agent.tool.completed": {
      const name =
        typeof payload.name === "string"
          ? payload.name
          : payload.type === "agent.tool.completed"
            ? `Tool ${String(payload.status ?? "completed")}`
            : "Agent tool";
      const failed =
        payload.status === "failed" ||
        payload.status === "error" ||
        payload.isError === true;
      const phase =
        payload.type === "agent.tool.completed"
          ? failed
            ? "failed"
            : "completed"
          : "started";
      const groupId =
        typeof payload.toolCallId === "string"
          ? payload.toolCallId
          : typeof payload.toolUseId === "string"
            ? payload.toolUseId
            : eventId;
      return {
        ...common,
        kind: "tool",
        text: name,
        format: "plain",
        toolGroup: legacyToolGroupPresentation({
          groupId,
          name,
          timestamp,
          phase,
          isError: failed,
        }),
        ...(typeof payload.toolCallId === "string"
          ? { toolCallId: payload.toolCallId }
          : {}),
        ...(payload.type === "agent.tool.started"
          ? { toolStatus: "running" as const }
          : payload.status === "succeeded" || payload.status === "failed"
            ? { toolStatus: payload.status }
            : {}),
      };
    }
    case "agent.permission.requested":
      return {
        ...common,
        kind: "permission",
        text:
          typeof payload.title === "string"
            ? payload.title
            : "Permission required",
        format: "plain",
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
        format: "plain",
      };
    default:
      return {
        ...common,
        kind: "notice",
        text: humanizeField(payload.type),
        format: "plain",
      };
  }
}

export function parseHistoryReplayEvent(
  eventId: string,
  sender: string,
  timestamp: number,
  content: Record<string, unknown>,
): { requestId: string; message: IncomingCodeverMessage } | null {
  const extension = asRecord(content["io.codever"]);
  const marker = asRecord(extension?.history_replay);
  if (
    marker?.display_only !== true ||
    typeof marker.request_id !== "string" ||
    !marker.request_id
  ) {
    return null;
  }
  const replayTimestamp = isNonnegativeInteger(marker.timestamp)
    ? marker.timestamp
    : timestamp;
  if (
    extension?.kind === "command_result" &&
    extension.outcome === "failed" &&
    typeof extension.command_id === "string"
  ) {
    return {
      requestId: marker.request_id,
      message: {
        eventId,
        sender,
        timestamp: replayTimestamp,
        encrypted: true,
        kind: "error",
        text:
          typeof extension.error === "string"
            ? extension.error
            : "The Gateway accepted the command but could not complete it.",
        format: "plain",
        commandId: extension.command_id,
        ...(isPositiveInteger(extension.revision)
          ? { revision: extension.revision }
          : {}),
        ...(typeof extension.session_id === "string" && extension.session_id
          ? { sessionId: extension.session_id }
          : {}),
        historical: true,
        raw: extension,
      },
    };
  }
  const parsed = parseCodeverEvent(
    eventId,
    sender,
    replayTimestamp,
    true,
    content,
  );
  return parsed
    ? {
        requestId: marker.request_id,
        message: { ...parsed, historical: true },
      }
    : null;
}

type DecodedHistoricalEvent = {
  gatewaySessionId?: string | null;
  message?: IncomingCodeverMessage;
};

async function historyItemsFromPage(
  page: HistoryPage,
  client: MatrixClient,
): Promise<HistoryItem[] | null> {
  if (page.items) return page.items;
  if (!page.batch) return null;
  const batch = page.batch;
  const url = client.mxcUrlToHttp(
    batch.media.url,
    undefined,
    undefined,
    undefined,
    false,
    false,
    true,
  );
  if (!url) throw new Error("Matrix history media URL could not be resolved.");
  const accessToken = client.getAccessToken();
  if (!accessToken) {
    throw new Error("Matrix access token is unavailable for history download.");
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Matrix history download failed with HTTP ${response.status}.`);
  }
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > batch.media.size) {
    throw new Error("Encrypted history page is larger than its signed metadata.");
  }
  const ciphertext = await readBoundedResponse(response, batch.media.size);
  const plaintext = await decryptMedia(ciphertext, batch.media);
  return decodeHistoryBatchPayload(plaintext, batch);
}

export async function decodeHistoryBatchPayload(
  plaintext: Uint8Array,
  batch: HistoryBatch,
): Promise<HistoryItem[]> {
  if (
    plaintext.byteLength !== batch.plaintextSize ||
    (await sha256(plaintext)) !== batch.plaintextSha256
  ) {
    throw new Error("History page content does not match its signed metadata.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    ) as unknown;
  } catch (error) {
    throw new Error("Encrypted history page is not valid JSON.", { cause: error });
  }
  const items = historyItemsSchema.parse(decoded);
  if (items.length !== batch.itemCount) {
    throw new Error("Encrypted history page item count does not match.");
  }
  return items;
}

function withHistoryReplayMarker(
  content: Record<string, JsonValue>,
  requestId: string,
  timestamp: number,
): Record<string, unknown> {
  const copy = structuredClone(content) as Record<string, unknown>;
  const extension = asRecord(copy["io.codever"]);
  if (extension) {
    extension.history_replay = {
      request_id: requestId,
      display_only: true,
      timestamp,
    };
  }
  return copy;
}

function deduplicateHistoryMessages(
  messages: readonly IncomingCodeverMessage[],
): IncomingCodeverMessage[] {
  const seenEventIds = new Set<string>();
  return messages.filter((message) => {
    if (seenEventIds.has(message.eventId)) return false;
    seenEventIds.add(message.eventId);
    return true;
  });
}

function isGatewaySecureEnvelopeExtension(
  extension: Record<string, unknown> | null,
): boolean {
  return Boolean(
    (extension?.kind === "secure_envelope" && extension.secure_envelope) ||
      (extension?.kind === "secure_envelope_bundle" &&
        extension.secure_envelope_bundle),
  );
}

async function openGatewaySecureEnvelope(
  extension: Record<string, unknown>,
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  trust: TrustedGateway,
  replayStore: ReplayStore,
  historical: boolean,
): Promise<JsonValue | null> {
  const expected = {
    gatewayId: trust.gatewayId,
    conversationId: config.conversationId,
    direction: "gateway_to_device" as const,
    senderDeviceId: trust.certificate.certificate.gatewayId,
    senderKeyId: trust.gatewayKey.keyId,
    recipientDeviceId: trust.certificate.certificate.deviceId,
    recipientKeyId: identity.keyId,
  };
  if (
    extension.kind === "secure_envelope_bundle" &&
    extension.secure_envelope_bundle
  ) {
    const routed = signedSecureEnvelopeBundleSchema.safeParse(
      extension.secure_envelope_bundle,
    );
    if (!routed.success) {
      throw new Error(
        historical
          ? "An archived Gateway envelope bundle is malformed."
          : "The secure Gateway envelope bundle is malformed.",
      );
    }
    const addressed = routed.data.bundle.recipients.some(
      (recipient) =>
        recipient.recipientDeviceId === expected.recipientDeviceId &&
        recipient.recipientKeyId === expected.recipientKeyId,
    );
    if (!addressed) return null;
    const opened = await openSecureEnvelopeBundle(
      extension.secure_envelope_bundle,
      {
        recipientPrivateKey: identity.privateKey,
        senderPublicKey: trust.gatewayKey.publicKey,
        expected,
        replayStore,
        ...(historical ? { now: routed.data.bundle.issuedAt } : {}),
      },
    );
    return opened.plaintext;
  }

  const routed = signedSecureEnvelopeSchema.safeParse(
    extension.secure_envelope,
  );
  if (!routed.success) {
    throw new Error(
      historical
        ? "An archived Gateway envelope is malformed."
        : "The secure Gateway envelope is malformed.",
    );
  }
  if (
    routed.data.envelope.recipientDeviceId !== expected.recipientDeviceId ||
    routed.data.envelope.recipientKeyId !== expected.recipientKeyId
  ) {
    return null;
  }
  const opened = await openSecureEnvelope(extension.secure_envelope, {
    recipientPrivateKey: identity.privateKey,
    senderPublicKey: trust.gatewayKey.publicKey,
    expected,
    replayStore,
    ...(historical ? { now: routed.data.envelope.issuedAt } : {}),
  });
  return opened.plaintext;
}

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
  if (!content || !isGatewaySecureEnvelopeExtension(extension)) {
    return null;
  }
  const plaintext = await openGatewaySecureEnvelope(
    extension!,
    config,
    identity,
    trust,
    replayStore,
    true,
  );
  if (plaintext === null) return null;
  const decryptedContent = asRecord(plaintext);
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
        format: "plain",
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

function deduplicateIncomingMessages(
  messages: readonly IncomingCodeverMessage[],
): IncomingCodeverMessage[] {
  const byEventId = new Map<string, IncomingCodeverMessage>();
  for (const message of messages) byEventId.set(message.eventId, message);
  return [...byEventId.values()];
}

function parseAttachments(value: unknown): CodeverAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value.flatMap((candidate) => {
    const parsed = attachmentSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
  return attachments.length > 0 ? attachments : undefined;
}

export async function processGatewayTimelineEvent(
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
  onHistoryReplay?: (
    requestId: string,
    message: IncomingCodeverMessage,
  ) => boolean,
  onHistoryPage?: (page: HistoryPage) => void,
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
  const applicationControl =
    event.getType() === CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE;
  if (!applicationControl &&
      (event.getType() === "m.room.encrypted" || event.isEncrypted())) {
    await client.decryptEventIfNeeded(event);
  }
  if (event.isDecryptionFailure()) {
    // A fresh Matrix device cannot decrypt room history sent before it joined.
    // Live events remain eligible for Event.decrypted after the matching
    // Megolm key arrives. The outer live-event processor bounds that retry;
    // marking the event seen here would permanently lose command acks/results.
    return;
  }
  if (!applicationControl && event.getType() !== "m.room.message") return;
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
      getTrust,
    );
    seen.add(eventId);
    return;
  }
  if (
    !isGatewaySecureEnvelopeExtension(extension) ||
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
  if (applicationControl) {
    if (event.isEncrypted() || sender !== trust.gatewayTransport.userId) {
      throw new Error(
        "Rejected a Codever control event outside the pinned Gateway transport.",
      );
    }
  }
  let plaintext: JsonValue | null;
  try {
    plaintext = await openGatewaySecureEnvelope(
      extension!,
      config,
      identity,
      trust,
      replayStore,
      false,
    );
  } catch (error) {
    if (error instanceof SecurityError && error.code === "replay") {
      // Initial sync includes already-rendered history. Persistent replay state
      // keeps it non-executable; it should not turn a normal reconnect red.
      seen.add(eventId);
      return;
    }
    throw error;
  }
  if (plaintext === null) {
    // This untrusted header is used only to route away another device's
    // ciphertext. Every entry addressed to this device is still opened and
    // authenticated before any plaintext or control callback is accepted.
    seen.add(eventId);
    return;
  }
  const decryptedContent = asRecord(plaintext);
  if (!decryptedContent) {
    throw new Error("The secure Gateway envelope did not contain Matrix content.");
  }
  const decryptedExtension = asRecord(decryptedContent["io.codever"]);
  const historyReplay = parseHistoryReplayEvent(
    eventId,
    trust.gatewayId,
    event.getTs(),
    decryptedContent,
  );
  if (historyReplay) {
    seen.add(eventId);
    const consumed = onHistoryReplay?.(
      historyReplay.requestId,
      historyReplay.message,
    ) ?? false;
    if (!consumed) onMessage(historyReplay.message);
    return;
  }
  if (decryptedExtension?.kind === "history_page") {
    const page = historyPageSchema.parse(decryptedExtension.history_page);
    seen.add(eventId);
    // Media download and parsing run on their own serial lane. Awaiting them
    // here would head-of-line block command acknowledgements/results.
    onHistoryPage?.(page);
    return;
  }
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
        format: "plain",
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
  getTrust?: () => TrustedGateway | null,
): Promise<void> {
  const trust = getTrust?.() ?? (await loadTrustedGateway(identity));
  if (!trust) return;
  const signedRotation = signedGatewayDeviceRotationSchema.parse(input);
  const nextTrust = await applyGatewayDeviceRotation(trust, signedRotation);
  if (nextTrust === trust) return;
  const rotation = signedRotation.rotation;
  // The replacement device sends this event, so transport identity is checked
  // only after the persistent Gateway application key authorizes the rotation.
  assertMatrixEventMatchesTransport(event, rotation.nextTransport);
  await verifyAndPinGatewayDevice(client, rotation.nextTransport);
  // The existing Megolm outbound session was created before the replacement
  // Gateway Matrix device existed, so it has no room key for that device.
  // Rotate the transport session after the application-signed device rotation.
  await client.getCrypto()?.forceDiscardSession(config.roomId);
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
    format: "plain",
    raw: { type: "gateway.device.rotated", rotationId: rotation.rotationId },
  });
}

async function recoverGatewayTransportSnapshot(
  client: MatrixClient,
  config: MatrixConnectionConfig,
  trust: TrustedGateway,
): Promise<TrustedGateway> {
  let content: Record<string, unknown>;
  try {
    const profileValue = await client.getExtendedProfileProperty(
      trust.gatewayTransport.userId,
      CODEVER_GATEWAY_TRANSPORT_PROFILE_FIELD,
    );
    if (!profileValue || typeof profileValue !== "object") {
      throw new Error("The Gateway transport recovery profile is malformed.");
    }
    content = profileValue as Record<string, unknown>;
  } catch (error) {
    if (isMatrixNotFound(error)) return trust;
    throw error;
  }
  const signedSnapshot = content.signed_snapshot;
  if (content.version !== 1 || !signedSnapshot) {
    throw new Error("The Gateway transport recovery profile is malformed.");
  }
  const nextTrust = await applyGatewayTransportSnapshot(
    trust,
    signedSnapshot,
  );
  if (nextTrust === trust) return trust;
  await verifyAndPinGatewayDevice(client, nextTrust.gatewayTransport);
  saveTrustedGateway(nextTrust);
  config.gatewayMatrixUserId = nextTrust.gatewayTransport.userId;
  config.gatewayMatrixDeviceId = nextTrust.gatewayTransport.deviceId;
  config.gatewayMatrixEd25519 = nextTrust.gatewayTransport.ed25519;
  saveMatrixConfig(config);
  return nextTrust;
}

function isMatrixNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    errcode?: unknown;
    httpStatus?: unknown;
    status?: unknown;
  };
  return (
    candidate.errcode === "M_NOT_FOUND" ||
    candidate.httpStatus === 404 ||
    candidate.status === 404
  );
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
  homeserver: string;
  roomId: string;
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
    homeserver: config.homeserver,
    roomId: config.roomId,
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
        const retainForResult = retainsCommandUntilResultConsumed(
          state.pending.payload,
        );
        return {
          ...state,
          lastAcknowledged: reservation.sequence,
          lastRevision: Math.max(state.lastRevision, revision),
          revisionInitialized: true,
          pending: retainForResult ? state.pending : undefined,
        };
      }
      // A historical acknowledgement for a different command must not clear
      // the current outbox reservation.
      return state;
    },
  );
}

async function savePendingCommandCompletion(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  sequenceEpoch: string,
  completion: CommandCompletion,
): Promise<void> {
  await updateCommandSequenceState(
    commandSequenceScope(config, identity, sequenceEpoch),
    (state) =>
      state.pending?.commandId === completion.commandId &&
      retainsCommandUntilResultConsumed(state.pending.payload)
        ? {
            ...state,
            pending: {
              ...state.pending,
              completion: structuredClone(completion),
            },
          }
        : state,
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
  expectedCommandId?: string,
): Promise<{
  eventId: string;
  payload: CommandPayload;
  reservation: CommandReservation;
  expired: boolean;
  completion?: CommandCompletion;
} | null> {
  const scope = commandSequenceScope(config, identity, sequenceEpoch);
  const state = await readCommandSequenceState(scope);
  const pending = state.pending;
  if (!pending) {
    if (expectedCommandId) {
      throw new Error(
        `The durable command ${expectedCommandId} is no longer pending.`,
      );
    }
    return null;
  }
  if (expectedCommandId && pending.commandId !== expectedCommandId) {
    throw new Error(
      `Refusing to recover command ${expectedCommandId}; command ${pending.commandId} is pending instead.`,
    );
  }
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
  if (typeof command?.expiresAt !== "number") {
    throw new Error(
      "The queued command is invalid. Re-pair this device to start a fresh secure command sequence.",
    );
  }
  const expired = command.expiresAt <= Date.now();
  if (pending.completion) {
    return {
      eventId: `$codever.durable.${pending.commandId}`,
      payload: pending.payload,
      reservation: pending,
      expired,
      completion: pending.completion,
    };
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
    expired,
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
    !isValidPendingCommandSequence(
      pending.sequence,
      lastAcknowledged,
      pending.payload as CommandPayload,
    ) ||
    typeof pending.createdAt !== "number" ||
    !Number.isSafeInteger(pending.createdAt)
  ) {
    throw new Error("The persistent command outbox is corrupt.");
  }
  const completion = parsePersistedCommandCompletion(
    pending.completion,
    pending.commandId,
  );
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
      ...(completion ? { completion } : {}),
    },
  };
}

function parsePersistedCommandCompletion(
  value: unknown,
  commandId: string,
): CommandCompletion | undefined {
  const completion = asRecord(value);
  if (!completion) return undefined;
  if (
    completion.commandId !== commandId ||
    typeof completion.sequence !== "number" ||
    !Number.isSafeInteger(completion.sequence) ||
    completion.sequence < 1 ||
    typeof completion.revision !== "number" ||
    !Number.isSafeInteger(completion.revision) ||
    completion.revision < 0 ||
    (completion.outcome !== "succeeded" && completion.outcome !== "failed")
  ) {
    throw new Error("The persistent command result is corrupt.");
  }
  const result =
    completion.result === undefined
      ? undefined
      : jsonValueSchema.safeParse(completion.result);
  if (result && !result.success) {
    throw new Error("The persistent command result payload is corrupt.");
  }
  return {
    commandId,
    sequence: completion.sequence,
    revision: completion.revision,
    outcome: completion.outcome,
    ...(typeof completion.sessionId === "string"
      ? { sessionId: completion.sessionId }
      : {}),
    ...(result ? { result: result.data } : {}),
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
    case "session.archive":
      return "Archive an agent session";
    case "session.restore":
      return "Restore an archived agent session";
    case "session.delete":
      return "Delete an agent session from Codever";
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

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error("Encrypted attachment exceeds its signed size.");
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Encrypted attachment exceeds its signed size.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
