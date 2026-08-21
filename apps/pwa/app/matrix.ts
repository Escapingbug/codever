import {
  CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE,
  CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
  CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE,
  CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE,
  capabilityRenewalOfferSchema,
  capabilityRenewalRequestSchema,
  canonicalJson,
  MAX_CODEVER_ATTACHMENT_BYTES,
  attachmentSchema,
  matrixNativeContentSchema,
  matrixStateEventContentSchema,
  matrixStateContentSchema,
  matrixTimelineKeyRingGrantSchema,
  signedMatrixStateEnvelopeSchema,
  signedMatrixTimelineEnvelopeSchema,
  type CodeverAttachment,
  type CodeverCommand,
  type CapabilityRenewalOffer,
  type CommandOperation,
  type CommandPayload,
  type JsonValue,
  type MatrixNativeContent,
  type MatrixGatewayState,
  type MatrixSessionDirectoryPage,
  type MatrixStateContent,
  type SignedCommand,
  type SessionExtensionBinding,
} from "@codever/protocol";
import {
  generateDeviceKeyPair,
  decryptMedia,
  base64UrlDecode,
  encryptMedia,
  openSecureEnvelopeBundle,
  openSecureEnvelope,
  openMatrixStateEnvelope,
  openMatrixTimelineEnvelope,
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
} from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events";
import {
  applyGatewayDeviceRotation,
  applyGatewayTransportSnapshot,
  completePairing,
  inspectPairingLink,
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
  type PairingOperation,
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
  isValidPendingCommandSequence,
  retainsCommandUntilResultConsumed,
} from "./durableCommandRecovery";
import {
  acquireMatrixCryptoLock,
  flushAndReleaseMatrixSyncStore,
  flushMatrixSyncStore,
  matrixCryptoLockName,
  matrixSyncDatabaseName,
  waitForMatrixSyncStoreClose,
} from "./matrixSyncStore";
import {
  classifyGatewayStateEpoch,
  classifyGatewayStateProgress,
  createGatewayStateCacheRecord,
  isIgnorableGatewayStateReplay,
  type GatewayStateCacheBinding,
  type GatewayStateSnapshot,
} from "./gatewayState";
import {
  messageFormat,
  parseExtensionViewPresentation,
  parseToolGroupPresentation,
  type MessageFormat,
  type ToolGroupPresentation,
} from "./presentation";
import {
  MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_DETAIL,
  MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_MS,
  MATRIX_CRYPTO_LOADING_DETAIL,
  MATRIX_SYNC_STORE_RECOVERY_DETAIL,
  MATRIX_SYNC_STORE_SAVE_DETAIL,
  matrixInitialSyncLimit,
  shouldRebuildMatrixSyncStore,
} from "./matrixStartup";
import { processMatrixEventWithDecryptionRetry } from "./matrixDecryptionRetry";
import { MatrixNativeProjection } from "./matrixNativeProjection";
import { canonicalSessionCommandResult } from "./canonicalCommandCompletion";
export {
  parseGatewayStateExtension,
  type GatewayCapabilities,
  type GatewayCapabilityOption,
  type GatewaySessionSummary,
  type GatewayStateSnapshot,
  type GatewayWorkspaceState,
  classifyGatewayStateEpoch,
} from "./gatewayState";

export const MATRIX_CONFIG_STORAGE_KEY = "codever.matrix.connection.v1";
export const MATRIX_IDENTITY_DATABASE_NAME = "codever-pwa-identity";
const DEVICE_STORE = "keys";
const DEVICE_KEY = "p256-v1";
const COMMAND_SEQUENCE_STORE = "command-sequences";
const TIMELINE_KEY_STORE = "matrix-timeline-keys";
const COMMAND_TTL_MS = 2 * 60_000;
const COMMAND_RECOVERY_INTERVAL_MS = 30_000;
const INCOMPLETE_OUTBOX_LEASE_MS = 30_000;
const LOCAL_STORE_TIMEOUT_MS = 10_000;
const DEVICE_KEYS_UPLOAD_TIMEOUT_MS = 30_000;
const GATEWAY_DEVICE_TIMEOUT_MS = 15_000;
const ENCRYPTED_SEND_TIMEOUT_MS = 20_000;
const CAPABILITY_RENEWAL_TIMEOUT_MS = 30_000;

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
  needsSigning?: boolean;
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

type CapabilityRenewalMigration = {
  version: 1;
  previousSequenceEpoch: string;
  createdAt: number;
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
 * The UI may retain a command identity across a page or APK upgrade. Expose a
 * transport-neutral error code when that exact durable command no longer
 * exists so startup reconciliation can retire the old UI marker instead of
 * retrying it forever.
 */
export class CommandRecoveryNotFoundError extends Error {
  readonly errorCode = "OPERATION_NOT_FOUND";

  constructor(
    readonly commandId: string,
    message = `The durable command ${commandId} is no longer available for recovery.`,
  ) {
    super(message);
    this.name = "CommandRecoveryNotFoundError";
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
  updateProjectExtensions?(
    extensions: SessionExtensionBinding[],
  ): Promise<CommandSendResult>;
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
    onConvergenceRequired?(): void;
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
  let refreshNativeStateAfterReconnect = false;
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
  const sessionRootEventIds = new Map<string, string>();
  const historyRelationTokens = new Map<string, string | null>();
  const initializedHistoryRelations = new Set<string>();
  const historyChains = new Map<string, Promise<unknown>>();
  const inFlightHistoryLoads = new Map<string, Promise<MatrixHistoryPage>>();
  const nativeProjection = new MatrixNativeProjection();
  let roomStateChain: Promise<void> = Promise.resolve();
  const outboundCommandMetadata = new Map<
    string,
    { reservation: CommandReservation; payload: CommandPayload }
  >();
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
    const recorded = commandLifecycle.recordResult(result);
    if (recorded) handlers.onCommandResult?.(result);
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
  const acceptCanonicalNativeCommandResult = async (
    content: MatrixStateContent,
  ): Promise<void> => {
    const sourceCommandId = "source_command_id" in content
      ? content.source_command_id
      : undefined;
    if (!sourceCommandId) return;
    const trust = activeTrust;
    const metadata = outboundCommandMetadata.get(sourceCommandId);
    if (!trust || !metadata) return;
    if (metadata.reservation.revisionEpoch !== content.revision_epoch) return;
    const projectedLifecycleState = content.kind === "session_state"
      ? nativeProjection.sessionLifecycleState(content.session_id)
      : null;
    const sessionId = canonicalSessionCommandResult(
      metadata.payload,
      content,
      projectedLifecycleState,
    );
    if (!sessionId) return;
    const completion: CommandResultState = {
      commandId: sourceCommandId,
      sequence: metadata.reservation.sequence,
      revision: content.revision,
      outcome: "succeeded",
      sessionId,
    };
    await onCommandAcknowledged(
      completion.commandId,
      completion.sequence,
      completion.revision,
      content.revision_epoch,
    );
    if (retainsCommandUntilResultConsumed(metadata.payload)) {
      await savePendingCommandCompletion(
        config,
        identity,
        trust.certificate.certificate.certificateId,
        completion,
      );
    }
    const recorded = commandLifecycle.recordResult(completion);
    if (recorded) handlers.onCommandResult?.(completion);
  };
  let lastCommandRecoveryState: string | null = null;
  let commandRecoveryAtState: Promise<void> | null = null;
  let commandRecoveryTimer: number | null = null;
  const recoverPendingCommand = (
    trust: TrustedGateway,
    reportError: boolean,
  ): void => {
    if (commandRecoveryAtState || stopped) return;
    commandRecoveryAtState = ensurePendingCommandCapability(trust).then(
      (currentTrust) => retryPendingCommand(
        client,
        config,
        identity,
        currentTrust.certificate.certificate.certificateId,
        currentTrust,
      ),
    ).then((recovered) => {
      if (!recovered) return;
      outboundCommandMetadata.set(recovered.reservation.commandId, {
        reservation: recovered.reservation,
        payload: structuredClone(recovered.payload),
      });
      if (recovered.completion) {
        const recorded = commandLifecycle.recordResult(recovered.completion);
        if (recorded) handlers.onCommandResult?.(recovered.completion);
      }
    }).finally(() => {
      commandRecoveryAtState = null;
    });
    void commandRecoveryAtState.catch((error) => {
      if (reportError) handlers.onStatus("error", formatError(error));
    });
  };
  const scheduleCommandRecoveryAtState = (
    gatewayState: MatrixGatewayState,
    trust: TrustedGateway,
  ): void => {
    const stateKey = [
      gatewayState.revision_epoch_generation,
      gatewayState.revision_epoch,
      gatewayState.state_version,
    ].join(":");
    if (
      stateKey === lastCommandRecoveryState ||
      commandRecoveryAtState
    ) return;
    lastCommandRecoveryState = stateKey;
    recoverPendingCommand(trust, true);
  };
  const onNativeContent = async (
    content: MatrixNativeContent,
    eventId: string,
  ): Promise<void> => {
    if (content.kind === "session_root") {
      sessionRootEventIds.set(content.session_id, eventId);
    }
    const state = nativeProjection.applyTimeline(content);
    if (state) await onGatewayState(state);
  };
  const onNativeSessionStatus = async (
    extension: Record<string, unknown>,
  ): Promise<void> => {
    const state = nativeProjection.applySessionStatus(extension);
    if (state) await onGatewayState(state);
  };
  const onRoomStateContent = async (
    content: MatrixStateContent,
    publish = true,
    recoverCommands = true,
  ): Promise<void> => {
    if (content.kind === "session_directory") return;
    if (content.kind === "session_state" && content.session?.thread_root_event_id) {
      sessionRootEventIds.set(
        content.session_id,
        content.session.thread_root_event_id,
      );
    }
    const state = await nativeProjection.applyRoomState(content);
    // Apply first, persist the terminal command second, and only then publish
    // the inventory. This keeps visible state behind the durable completion
    // barrier while refusing stale entity events that lost projection order.
    await acceptCanonicalNativeCommandResult(content);
    if (publish && state) await onGatewayState(state);
    if (recoverCommands && content.kind === "gateway_state") {
      const trust = activeTrust;
      if (trust) scheduleCommandRecoveryAtState(content, trust);
    }
  };
  const decodeRoomStateEvent = async (
    event: MatrixEvent,
  ): Promise<MatrixStateContent | null> => {
    const eventType = event.getType();
    if (
      eventType !== CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE &&
      eventType !== CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE &&
      eventType !== CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE
    ) return null;
    const stateKey = event.getStateKey();
    const sender = event.getSender();
    const trust = activeTrust;
    if (!stateKey || !sender || !trust) return null;
    if (sender !== trust.gatewayTransport.userId) {
      throw new Error("Rejected Codever Room State outside the pinned Gateway transport.");
    }
    if (
      (eventType === CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE && stateKey !== config.gatewayId)
    ) {
      throw new Error("Rejected Codever Room State with an invalid state key.");
    }
    const content = matrixStateEventContentSchema.parse(event.getContent());
    const signed = signedMatrixStateEnvelopeSchema.parse(content.state_envelope);
    let key = await loadTimelineKey(config, identity, signed.envelope.epochId);
    if (!key) {
      if (!content.timeline_key_ring_bundle) {
        throw new Error("The current Codever Room State key is unavailable.");
      }
      const bundle = signedSecureEnvelopeBundleSchema.parse(content.timeline_key_ring_bundle);
      const certificate = trust.certificate.certificate;
      const addressed = bundle.bundle.recipients.some(
        (recipient) =>
          recipient.recipientDeviceId === certificate.deviceId &&
          recipient.recipientKeyId === identity.keyId,
      );
      if (!addressed) return null;
      const openedGrant = await openSecureEnvelopeBundle(
        content.timeline_key_ring_bundle,
        {
          recipientPrivateKey: identity.privateKey,
          senderPublicKey: trust.gatewayKey.publicKey,
          expected: {
            gatewayId: trust.gatewayId,
            conversationId: config.conversationId,
            direction: "gateway_to_device",
            senderDeviceId: certificate.gatewayId,
            recipientDeviceId: certificate.deviceId,
            senderKeyId: trust.gatewayKey.keyId,
            recipientKeyId: identity.keyId,
          },
          replayStore: historyReplayStore,
          now: bundle.bundle.issuedAt,
        },
      );
      await saveTimelineKeyRing(config, identity, openedGrant.plaintext);
      key = await loadTimelineKey(config, identity, signed.envelope.epochId);
    }
    if (!key) throw new Error("The current Codever Room State key is unavailable.");
    const plaintext = await openMatrixStateEnvelope(content.state_envelope, {
      timelineKey: key,
      gatewayPublicKey: trust.gatewayKey.publicKey,
      expected: {
        gatewayId: config.gatewayId,
        conversationId: config.conversationId,
        roomId: config.roomId,
        eventType,
        stateKey,
        epochId: signed.envelope.epochId,
        stateVersion: signed.envelope.stateVersion,
      },
    });
    if (
      (plaintext.kind === "gateway_state" && stateKey !== plaintext.gateway_id) ||
      (plaintext.kind === "session_state" && stateKey !== plaintext.session_id) ||
      (plaintext.kind === "session_directory" &&
        stateKey !== matrixDirectoryStateKey(plaintext, plaintext.page_index))
    ) {
      throw new Error("Codever Room State entity binding does not match its state key.");
    }
    return matrixStateContentSchema.parse(plaintext);
  };
  let authoritativeStateInitialized = false;
  const processRoomStateEvent = async (event: MatrixEvent): Promise<void> => {
    const content = await decodeRoomStateEvent(event);
    if (!content) return;
    const directoryChanged = authoritativeStateInitialized &&
      content.kind === "gateway_state" &&
      nativeProjection.requiresAuthoritativeDirectoryRefresh(content);
    const commandScopeChanged = directoryChanged &&
      content.kind === "gateway_state" &&
      nativeProjection.requiresCommandScopeRefresh(content);
    // Live state received during startup is authenticated and retained, but it
    // must not expose a partial inventory before the complete /state snapshot
    // has crossed its atomic publication barrier. A new directory commit is
    // likewise withheld until all of its immutable pages have been loaded.
    await onRoomStateContent(
      content,
      authoritativeStateInitialized && !directoryChanged,
    );
    if (directoryChanged) {
      window.queueMicrotask(() => recoverGatewayStateSnapshot({
        force: true,
        blocking: commandScopeChanged,
      }));
    }
  };
  const enqueueRoomStateEvent = (event: MatrixEvent): Promise<void> => {
    const operation = roomStateChain.then(() => processRoomStateEvent(event));
    roomStateChain = operation.catch(() => undefined);
    return operation;
  };
  const loadAuthoritativeRoomState = async (): Promise<void> => {
    const gatewaySender = activeTrust?.gatewayTransport.userId ?? config.gatewayMatrixUserId;
    const stateEvent = async (eventType: string, stateKey: string): Promise<MatrixEvent> => {
      const content = await client.getStateEvent(config.roomId, eventType, stateKey);
      return new sdk.MatrixEvent({
        type: eventType,
        state_key: stateKey,
        event_id: `$codever-current-state-${encodeURIComponent(eventType)}-${encodeURIComponent(stateKey)}`,
        room_id: config.roomId,
        sender: gatewaySender,
        origin_server_ts: 0,
        content,
      });
    };
    let gatewayContent: MatrixGatewayState | null = null;
    let directoryPages: MatrixSessionDirectoryPage[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = await decodeRoomStateEvent(await stateEvent(
        CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
        config.gatewayId,
      ));
      if (!before || before.kind !== "gateway_state") {
        throw new Error("The Gateway Room State is unavailable.");
      }
      const descriptor = before.session_directory;
      const pages: MatrixSessionDirectoryPage[] = [];
      for (let pageIndex = 0; pageIndex < descriptor.page_count; pageIndex += 1) {
        const decoded = await decodeRoomStateEvent(await stateEvent(
          CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE,
          matrixDirectoryStateKey(descriptor, pageIndex),
        ));
        if (!decoded || decoded.kind !== "session_directory") {
          throw new Error(`Matrix session directory page ${pageIndex} is unavailable.`);
        }
        pages.push(decoded);
      }
      const after = await decodeRoomStateEvent(await stateEvent(
        CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
        config.gatewayId,
      ));
      if (!after || after.kind !== "gateway_state") {
        throw new Error("The Gateway Room State is unavailable.");
      }
      if (!sameMatrixDirectory(before, after)) continue;
      validateMatrixDirectory(after, pages);
      gatewayContent = after;
      directoryPages = pages;
      break;
    }
    if (!gatewayContent) {
      throw new Error("The Matrix session directory changed continuously while reconnecting.");
    }
    const directorySessions = directoryPages.flatMap((page) => page.sessions);
    if ((await sha256(canonicalJson(directorySessions))) !== gatewayContent.session_directory.digest) {
      throw new Error("The Matrix session directory digest does not match its Gateway commit.");
    }
    const sessionContents = directoryPages.flatMap((page) =>
      page.sessions.map((session) => matrixStateContentSchema.parse({
        version: 2,
        kind: "session_state",
        gateway_id: page.gateway_id,
        conversation_id: page.conversation_id,
        revision: page.revision,
        revision_epoch: page.revision_epoch,
        revision_epoch_generation: page.revision_epoch_generation,
        state_version: page.state_version,
        session_id: session.session_id,
        state: session.archived ? "archived" : "active",
        session,
        updated_at: page.updated_at,
      })),
    );
    const operation = roomStateChain.then(async () => {
      const decodedState: MatrixStateContent[] = [gatewayContent!, ...sessionContents];
      const snapshot = await nativeProjection.applyRoomStateBatch(decodedState);
      if (!snapshot) throw new Error("The Gateway Room State is unavailable.");
      for (const content of decodedState) {
        if (content.kind === "session_state" && content.session?.thread_root_event_id) {
          sessionRootEventIds.set(
            content.session_id,
            content.session.thread_root_event_id,
          );
        }
        await acceptCanonicalNativeCommandResult(content);
      }
      authoritativeStateInitialized = true;
      await onGatewayState(snapshot);
      const trust = activeTrust;
      if (trust) scheduleCommandRecoveryAtState(gatewayContent!, trust);
    });
    roomStateChain = operation.catch(() => undefined);
    await operation;
  };
  const waitForAuthoritativeRoomState = async (
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    do {
      if (signal?.aborted) throw signal.reason;
      try {
        await loadAuthoritativeRoomState();
        return;
      } catch (error) {
        lastError = error;
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          window.clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = window.setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, 250);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    } while (Date.now() < deadline);
    throw new Error(
      `The Gateway did not publish complete current Matrix Room State after pairing: ${formatError(lastError)}`,
    );
  };
  const reportInboundError = (error: unknown) => {
    handlers.onStatus("error", formatError(error));
  };
  const capabilityRenewalWaiters = new Map<
    string,
    {
      certificateId: string;
      resolve: (offer: CapabilityRenewalOffer) => void;
    }
  >();
  const onCapabilityRenewalOffer = (offer: CapabilityRenewalOffer): void => {
    const waiter = capabilityRenewalWaiters.get(offer.request_id);
    if (
      !waiter ||
      waiter.certificateId !== offer.certificate_id ||
      offer.expires_at <= Date.now()
    ) {
      return;
    }
    waiter.resolve(offer);
  };
  let gatewayStateRecovery: Promise<void> | null = null;
  let gatewayStateRecoveryPending = false;
  let gatewayStateRecoveryPendingBlocking = false;
  let lastGatewayStateRecoveryAt = 0;
  const recoverGatewayStateSnapshot = (
    options: { force?: boolean; blocking?: boolean } = {},
  ): void => {
    const queueLatestRecovery = () => {
      gatewayStateRecoveryPending = true;
      gatewayStateRecoveryPendingBlocking ||= options.blocking !== false;
    };
    if (
      stopped ||
      !connectionReady ||
      !activeTrust
    ) {
      return;
    }
    if (document.visibilityState !== "visible" || gatewayStateRecovery) {
      if (options.force) queueLatestRecovery();
      return;
    }
    if (
      (!options.force && Date.now() - lastGatewayStateRecoveryAt < 2_000)
    ) {
      return;
    }
    lastGatewayStateRecoveryAt = Date.now();
    if (options.blocking !== false) handlers.onConvergenceRequired?.();
    gatewayStateRecovery = waitForAuthoritativeRoomState(undefined, 30_000)
      .catch(reportInboundError)
      .finally(() => {
        gatewayStateRecovery = null;
        if (!gatewayStateRecoveryPending) return;
        const blocking = gatewayStateRecoveryPendingBlocking;
        gatewayStateRecoveryPending = false;
        gatewayStateRecoveryPendingBlocking = false;
        // Directory commits are latest-wins. If create and delete snapshots
        // arrive while one materialization is in flight, never drop the later
        // commit: load the newest immutable descriptor immediately after the
        // current read releases the serialization barrier.
        window.queueMicrotask(() => recoverGatewayStateSnapshot({
          force: true,
          blocking,
        }));
      });
  };
  const onTimelineReset = (room: Room | undefined): void => {
    if (!room || room.roomId !== config.roomId) return;
    // Inventory is reconstructed from paginated state history, while selected
    // conversation text is reconstructed through the per-thread history API.
    // The live SDK timeline is only a wake-up stream and is never the sole
    // source of durable application truth.
    recoverGatewayStateSnapshot();
  };
  const onRoomState = (event: MatrixEvent): void => {
    if (stopped || event.getRoomId() !== config.roomId) return;
    void enqueueRoomStateEvent(event).catch(reportInboundError);
  };
  const onVisibilityRecovery = (): void => {
    if (document.visibilityState === "visible") recoverGatewayStateSnapshot();
  };
  const onFocusRecovery = (): void => recoverGatewayStateSnapshot();
  const removeBrowserRecoveryListeners = (): void => {
    document.removeEventListener("visibilitychange", onVisibilityRecovery);
    window.removeEventListener("focus", onFocusRecovery);
    window.removeEventListener("online", onFocusRecovery);
  };
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
          onNativeContent,
          onNativeSessionStatus,
          historical,
          onCapabilityRenewalOffer,
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
      // memory. The forced local-store flush is serialized before the next client
      // opens the same database; the stopped client no longer writes to it.
      void flushMatrixSyncStore(
        syncStoreDatabaseName,
        syncStore,
      ).catch((error) => {
        if (!stopped) {
          failPersistence(
            `The local Matrix sync cache could not be saved: ${formatError(error)}.`,
          );
        }
      });
      if (connectionReady && refreshNativeStateAfterReconnect) {
        refreshNativeStateAfterReconnect = false;
        void loadAuthoritativeRoomState().catch((error) => {
          refreshNativeStateAfterReconnect = true;
          reportInboundError(error);
        });
      }
      if (connectionReady) handlers.onStatus("connected");
    } else if (state === "RECONNECTING" || state === "CATCHUP") {
      refreshNativeStateAfterReconnect = true;
      handlers.onStatus("reconnecting");
    } else if (state === "ERROR") {
      // The Matrix SDK can emit ERROR between successful sync attempts. Treat
      // this as recoverable here; startup/authentication failures are surfaced
      // by the bounded connection path instead of flashing a fatal UI while
      // the SDK is already retrying.
      refreshNativeStateAfterReconnect = true;
      handlers.onStatus(
        "reconnecting",
        "Encrypted sync was interrupted. Retrying automatically…",
      );
    } else if (state === "STOPPED") {
      handlers.onStatus("offline");
    }
  };

  let rebuildingSyncStore = false;
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
    rebuildingSyncStore = shouldRebuildMatrixSyncStore(
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
      rebuildingSyncStore
        ? MATRIX_SYNC_STORE_RECOVERY_DETAIL
        : "Starting the first encrypted sync…",
    );
    await client.startClient({
      initialSyncLimit: matrixInitialSyncLimit(
        Boolean(activeTrust),
        rebuildingSyncStore,
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
    client.off(sdk.RoomEvent.TimelineReset, onTimelineReset);
    client.off(sdk.ClientEvent.Sync, onSync);
    removeBrowserRecoveryListeners();
    client.stopClient();
    let detail = formatError(error);
    try {
      await withMatrixTimeout(
        flushAndReleaseMatrixSyncStore(
          syncStoreDatabaseName,
          syncStore,
          cryptoLock,
        ),
        LOCAL_STORE_TIMEOUT_MS,
        "Timed out while closing the Matrix stores.",
      );
    } catch (cleanupError) {
      await cryptoLock.release().catch(() => undefined);
      detail = `${detail} The local Matrix stores could not be saved or closed cleanly: ${formatError(
        cleanupError,
      )} Reload this page before retrying.`;
    }
    handlers.onStatus("error", detail);
    throw new Error(detail);
  }
  if (!matrixDeviceKeys) {
    await flushAndReleaseMatrixSyncStore(
      syncStoreDatabaseName,
      syncStore,
      cryptoLock,
    );
    throw new Error("Matrix device keys were not initialized.");
  }
  if (!startupRoom) {
    await flushAndReleaseMatrixSyncStore(
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

    if (rebuildingSyncStore) {
      handlers.onStatus("securing", MATRIX_SYNC_STORE_SAVE_DETAIL);
      await withMatrixTimeout(
        flushMatrixSyncStore(syncStoreDatabaseName, syncStore),
        LOCAL_STORE_TIMEOUT_MS,
        "The rebuilt local Matrix sync cache could not be saved in time.",
      );
      assertStartupActive();
      if (!(await syncStore.getSavedSyncToken())) {
        throw new Error(
          "The local Matrix sync cache was rebuilt but could not be persisted. Check this browser’s storage settings and try again.",
        );
      }
    }

    // Install live listeners before the authoritative state read so neither
    // control-state nor new conversation events can fall into a startup gap.
    // Do not replay the SDK's initial room timeline here. Session history is
    // loaded through its thread/history API on demand; putting old room events
    // onto the live inbound queue would let arbitrary history volume delay a
    // newly arriving prompt or Agent result on another device.
    client.on(sdk.RoomEvent.Timeline, onTimeline);
    client.on(sdk.RoomEvent.TimelineReset, onTimelineReset);
    startupRoom.on(sdk.RoomStateEvent.Events, onRoomState);

    if (activeTrust) {
      handlers.onStatus(
        "securing",
        "Loading current sessions from Matrix Room State…",
      );
      await loadAuthoritativeRoomState();
      assertStartupActive();
    }

    assertPersistenceHealthy();
    connectionReady = true;
    commandRecoveryTimer = window.setInterval(() => {
      const trust = activeTrust;
      if (trust) recoverPendingCommand(trust, false);
    }, COMMAND_RECOVERY_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityRecovery);
    window.addEventListener("focus", onFocusRecovery);
    window.addEventListener("online", onFocusRecovery);
    handlers.onStatus("connected");
  };
  const startupReady = finishMatrixStartup();
  void startupReady.catch(async (error) => {
    if (stopped) return;
    stopped = true;
    client.off(sdk.RoomEvent.Timeline, onTimeline);
    client.off(sdk.RoomEvent.TimelineReset, onTimelineReset);
    startupRoom?.off(sdk.RoomStateEvent.Events, onRoomState);
    client.off(sdk.ClientEvent.Sync, onSync);
    removeBrowserRecoveryListeners();
    if (commandRecoveryTimer !== null) {
      window.clearInterval(commandRecoveryTimer);
      commandRecoveryTimer = null;
    }
    client.stopClient();
    let detail = formatError(error);
    try {
      await withMatrixTimeout(
        flushAndReleaseMatrixSyncStore(
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
  const completePairingPreview = async (
    preview: PairingPreview,
    deviceName: string,
    signal?: AbortSignal,
    waitForStartup = true,
  ): Promise<TrustedGateway> => {
    if (waitForStartup) await startupReady;
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
    handlers.onTrustUpdated?.(trust);
    handlers.onStatus("securing", "Loading current sessions from Matrix Room State…");
    await waitForAuthoritativeRoomState(signal);
    handlers.onStatus("connected");
    return trust;
  };
  const requestCapabilityRenewalOffer = async (
    trust: TrustedGateway,
    requestedOperations: readonly PairingOperation[],
  ): Promise<CapabilityRenewalOffer> => {
    const certificate = trust.certificate.certificate;
    if (!certificate.allowedOperations.includes("device.invite")) {
      throw new Error(
        "This device certificate cannot renew its permissions. Pair this device again with a new invitation.",
      );
    }
    const now = Date.now();
    const request = capabilityRenewalRequestSchema.parse({
      version: 1,
      kind: "capability_renewal_request",
      request_id: crypto.randomUUID(),
      gateway_id: trust.gatewayId,
      device_id: certificate.deviceId,
      certificate_id: certificate.certificateId,
      requested_operations: [...new Set(requestedOperations)],
      issued_at: now,
      expires_at: now + COMMAND_TTL_MS,
    });
    const offerPromise = new Promise<CapabilityRenewalOffer>((resolve) => {
      capabilityRenewalWaiters.set(request.request_id, {
        certificateId: certificate.certificateId,
        resolve,
      });
    });
    try {
      const plaintext = {
        msgtype: sdk.MsgType.Notice,
        body: "Encrypted Codever device permission renewal",
        "io.codever": request,
      };
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
      await sendCodeverApplicationControlEvent(
        client,
        config.roomId,
        {
          msgtype: sdk.MsgType.Notice,
          body: "Encrypted Codever device permission renewal",
          "io.codever": {
            version: 1,
            kind: "secure_envelope",
            secure_envelope: secureEnvelope,
          },
        } as unknown as RoomMessageEventContent,
        `codever.capability-renewal.${request.request_id}`,
      );
      return await withMatrixTimeout(
        offerPromise,
        CAPABILITY_RENEWAL_TIMEOUT_MS,
        "The Gateway did not renew this device’s permissions in time.",
      );
    } finally {
      capabilityRenewalWaiters.delete(request.request_id);
    }
  };
  let capabilityRenewal: Promise<TrustedGateway> | null = null;
  const renewCapabilities = async (
    trust: TrustedGateway,
    requestedOperations: readonly PairingOperation[],
  ): Promise<TrustedGateway> => {
    if (
      requestedOperations.every((operation) =>
        trust.certificate.certificate.allowedOperations.includes(operation)
      )
    ) {
      return trust;
    }
    capabilityRenewal ??= (async () => {
      handlers.onStatus(
        "securing",
        "Updating this device’s permissions for the current Codever version…",
      );
      const offer = await requestCapabilityRenewalOffer(
        trust,
        requestedOperations,
      );
      const preview = await inspectPairingLink(offer.pairing_link);
      if (
        preview.gatewayId !== trust.gatewayId ||
        canonicalJson(preview.signedOffer.offer.gatewayKey) !==
          canonicalJson(trust.gatewayKey)
      ) {
        throw new Error(
          "The permission renewal offer belongs to a different Gateway key.",
        );
      }
      if (
        requestedOperations.some(
          (operation) =>
            !preview.signedOffer.offer.allowedOperations.includes(operation),
        )
      ) {
        throw new Error(
          "The Gateway renewal offer does not authorize the required operation.",
        );
      }
      await saveCapabilityRenewalMigration(
        config,
        identity,
        trust.certificate.certificate.certificateId,
      );
      const renewed = await completePairingPreview(
        preview,
        trust.certificate.certificate.deviceName,
        undefined,
        false,
      );
      if (
        requestedOperations.some(
          (operation) =>
            !renewed.certificate.certificate.allowedOperations.includes(operation),
        )
      ) {
        throw new Error(
          "The renewed device certificate does not authorize the required operation.",
        );
      }
      return renewed;
    })().finally(() => {
      capabilityRenewal = null;
    });
    const renewed = await capabilityRenewal;
    if (
      requestedOperations.some(
        (operation) =>
          !renewed.certificate.certificate.allowedOperations.includes(operation),
      )
    ) {
      return renewCapabilities(renewed, requestedOperations);
    }
    return renewed;
  };
  const ensurePendingCommandCapability = async (
    trust: TrustedGateway,
    expectedCommandId?: string,
  ): Promise<TrustedGateway> => {
    const currentSequenceEpoch =
      trust.certificate.certificate.certificateId;
    const pendingMigration = await readCapabilityRenewalMigration(
      config,
      identity,
    );
    if (
      pendingMigration &&
      pendingMigration.previousSequenceEpoch !== currentSequenceEpoch
    ) {
      const migrated = await migratePendingCommandSequenceEpoch(
        config,
        identity,
        pendingMigration.previousSequenceEpoch,
        currentSequenceEpoch,
        expectedCommandId,
      );
      const currentPending: PendingOutboundCommand | undefined = migrated
        ? {
            ...migrated.reservation,
            createdAt: Date.now(),
            payload: migrated.payload,
            needsSigning: true,
          }
        : (await readCommandSequenceState(
            commandSequenceScope(config, identity, currentSequenceEpoch),
          )).pending;
      if (
        currentPending &&
        expectedCommandId &&
        currentPending.commandId !== expectedCommandId
      ) {
        throw new Error(
          `Refusing to recover command ${expectedCommandId}; command ${currentPending.commandId} is pending instead.`,
        );
      }
      if (currentPending?.needsSigning) {
        commandLifecycle.release(currentPending.commandId);
        outboundCommandMetadata.delete(currentPending.commandId);
        await preparePendingCommandPlaintext(
          config,
          identity,
          currentSequenceEpoch,
          currentPending,
          currentPending.payload,
        );
      }
      await clearCapabilityRenewalMigration(config, identity);
      return trust;
    }
    if (
      pendingMigration &&
      Date.now() - pendingMigration.createdAt > 10 * 60_000
    ) {
      // A one-time pairing exchange cannot still be live after this window.
      // Do not clear a fresh marker: another tab may be completing the
      // renewal and needs it to survive a crash between trust and WAL writes.
      await clearCapabilityRenewalMigration(config, identity);
    }
    const state = await readCommandSequenceState(
      commandSequenceScope(config, identity, currentSequenceEpoch),
    );
    const pending = state.pending;
    if (!pending) return trust;
    if (expectedCommandId && pending.commandId !== expectedCommandId) {
      return trust;
    }
    if (pending.needsSigning) {
      await preparePendingCommandPlaintext(
        config,
        identity,
        currentSequenceEpoch,
        pending,
        pending.payload,
      );
      return trust;
    }
    const operation = pending.payload.operation as PairingOperation;
    if (trust.certificate.certificate.allowedOperations.includes(operation)) {
      return trust;
    }
    const renewed = await renewCapabilities(trust, [operation]);
    const nextSequenceEpoch =
      renewed.certificate.certificate.certificateId;
    const migrated = await migratePendingCommandSequenceEpoch(
      config,
      identity,
      currentSequenceEpoch,
      nextSequenceEpoch,
      expectedCommandId,
    );
    if (migrated) {
      commandLifecycle.release(migrated.reservation.commandId);
      outboundCommandMetadata.delete(migrated.reservation.commandId);
      await preparePendingCommandPlaintext(
        config,
        identity,
        nextSequenceEpoch,
        migrated.reservation,
        migrated.payload,
      );
    }
    await clearCapabilityRenewalMigration(config, identity);
    return renewed;
  };
  const ensureOperationCapability = async (
    trust: TrustedGateway,
    operation: CommandOperation,
  ): Promise<TrustedGateway> => {
    const requiresRenewal =
      !trust.certificate.certificate.allowedOperations.includes(
        operation as PairingOperation,
      );
    const renewed = await renewCapabilities(
      trust,
      [operation as PairingOperation],
    );
    if (requiresRenewal) {
      await clearCapabilityRenewalMigration(config, identity);
    }
    return renewed;
  };
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
    let trust = activeTrust;
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
    trust = await ensurePendingCommandCapability(trust);
    let sequenceEpoch = trust.certificate.certificate.certificateId;
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
      outboundCommandMetadata.set(recovered.reservation.commandId, {
        reservation: recovered.reservation,
        payload: structuredClone(recovered.payload),
      });
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
          if (samePayload) {
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

    trust = await ensureOperationCapability(trust, payload.operation);
    sequenceEpoch = trust.certificate.certificate.certificateId;
    await assertRevisionInitialized(config, identity, sequenceEpoch);

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
    outboundCommandMetadata.set(reservation.commandId, {
      reservation,
      payload: structuredClone(payload),
    });
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
    let trust = activeTrust;
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
    trust = await ensurePendingCommandCapability(trust, commandId);
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
      throw new CommandRecoveryNotFoundError(commandId);
    }
    outboundCommandMetadata.set(recovered.reservation.commandId, {
      reservation: recovered.reservation,
      payload: structuredClone(recovered.payload),
    });
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
    const plaintext = await preparePendingCommandPlaintext(
      config,
      identity,
      sequenceEpoch,
      reservation,
      payload,
    );
    const certificate = trust.certificate.certificate;
    const secureEnvelope = await sealSecureEnvelope({
      plaintext: plaintext as JsonValue,
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
      msgtype: sdk.MsgType.Notice,
      body: "Encrypted Codever message",
      "io.codever": {
        version: 1,
        kind: "secure_envelope",
        secure_envelope: secureEnvelope,
      },
    } as unknown as RoomMessageEventContent;
    return sendCodeverApplicationControlEvent(
      client,
      config.roomId,
      content,
      `codever.command.${reservation.commandId}`,
    );
  };
  const scanHistoryEvents = async (
    events: readonly MatrixEvent[],
  ): Promise<void> => {
    const unseenEvents = events
      .filter((event) => {
        const eventId = event.getId();
        return Boolean(eventId && !historySeen.has(eventId));
      })
      .reverse();
    for (const event of unseenEvents) {
      const eventId = event.getId();
      if (!eventId) continue;
      const decoded = await decodeHistoricalEvent(
        event,
        config,
        identity,
        activeTrust,
        historyReplayStore,
      );
      if (!decoded) continue;
      historySeen.add(eventId);
      if (decoded?.gatewaySessionId !== undefined) {
        if (decoded.gatewaySessionId) {
          sessionRootEventIds.set(decoded.gatewaySessionId, eventId);
        }
      }
      if (!decoded.message) continue;
      const sessionId = decoded.message.sessionId;
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
  const sessionRootEventId = async (
    room: Room,
    sessionId: string,
  ): Promise<string | null> => {
    if (!sessionRootEventIds.has(sessionId)) {
      await room.fetchRoomThreads();
      await scanHistoryEvents(
        room.getThreads().flatMap((thread) =>
          thread.rootEvent ? [thread.rootEvent] : [],
        ),
      );
    }
    await scanHistoryEvents(room.getLiveTimeline().getEvents());
    return sessionRootEventIds.get(sessionId) ?? null;
  };
  const fetchSessionRelations = async (
    room: Room,
    sessionId: string,
    limit: number,
    from?: string,
  ): Promise<string | null> => {
    const rootEventId = await sessionRootEventId(room, sessionId);
    if (!rootEventId) return null;
    const page = await client.relations(
      config.roomId,
      rootEventId,
      sdk.RelationType.Thread,
      null,
      {
        dir: sdk.Direction.Backward,
        // Gateway events are individually capped at 40 KiB. Keep each
        // relations response under the same 2 MiB safety budget used by the
        // native client, then loop tokens to satisfy larger UI page requests.
        limit: Math.min(limit, 32),
        recurse: true,
        ...(from ? { from } : {}),
      },
    );
    await scanHistoryEvents([
      ...(page.originalEvent ? [page.originalEvent] : []),
      ...page.events,
    ]);
    return page.nextBatch ?? null;
  };
  const initializeSessionRelations = async (
    room: Room,
    sessionId: string,
    limit: number,
  ): Promise<void> => {
    if (initializedHistoryRelations.has(sessionId)) return;
    const nextToken = await fetchSessionRelations(room, sessionId, limit);
    initializedHistoryRelations.add(sessionId);
    historyRelationTokens.set(sessionId, nextToken);
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
    await initializeSessionRelations(room, sessionId, Math.max(30, pageLimit));
    const messages = takeHistory(sessionId, pageLimit);
    while (messages.length < pageLimit) {
      const from = historyRelationTokens.get(sessionId);
      if (!from) break;
      const before = historySeen.size;
      const nextToken = await fetchSessionRelations(
        room,
        sessionId,
        Math.max(30, pageLimit - messages.length),
        from,
      );
      historyRelationTokens.set(sessionId, nextToken);
      messages.push(...takeHistory(sessionId, pageLimit - messages.length));
      if (historySeen.size === before && nextToken === from) break;
    }
    return {
      messages: deduplicateIncomingMessages(messages).sort(compareIncomingMessages),
      hasMore:
        hasPendingHistory(sessionId) ||
        Boolean(historyRelationTokens.get(sessionId)),
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
    if (initializedHistoryRelations.has(sessionId)) {
      await fetchSessionRelations(room, sessionId, Math.max(30, pageLimit));
    } else {
      await initializeSessionRelations(room, sessionId, Math.max(30, pageLimit));
    }
    const local = (historyBySession.get(sessionId) ?? []).slice(-pageLimit);
    return {
      messages: deduplicateIncomingMessages(local).sort(compareIncomingMessages),
      hasMore:
        (historyBySession.get(sessionId)?.length ?? 0) > pageLimit ||
        Boolean(historyRelationTokens.get(sessionId)),
    };
  };
  const enqueueHistoryOperation = (
    sessionId: string,
    limit: number,
    operation: () => Promise<MatrixHistoryPage>,
  ): Promise<MatrixHistoryPage> => {
    const key = `${sessionId}\u0000${limit}`;
    const existing = inFlightHistoryLoads.get(key);
    if (existing) return existing;
    const previous = historyChains.get(sessionId) ?? Promise.resolve();
    const queued = previous.then(operation);
    const tail = queued.then(
      () => undefined,
      () => undefined,
    );
    historyChains.set(sessionId, tail);
    inFlightHistoryLoads.set(key, queued);
    return queued.finally(() => {
      if (inFlightHistoryLoads.get(key) === queued) {
        inFlightHistoryLoads.delete(key);
      }
      if (historyChains.get(sessionId) === tail) {
        historyChains.delete(sessionId);
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
      return completePairingPreview(preview, deviceName, signal);
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
      outboundCommandMetadata.delete(commandId);
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
      client.off(sdk.RoomEvent.Timeline, onTimeline);
      client.off(sdk.RoomEvent.TimelineReset, onTimelineReset);
      startupRoom?.off(sdk.RoomStateEvent.Events, onRoomState);
      client.off(sdk.ClientEvent.Sync, onSync);
      removeBrowserRecoveryListeners();
      if (commandRecoveryTimer !== null) {
        window.clearInterval(commandRecoveryTimer);
        commandRecoveryTimer = null;
      }
      client.stopClient();
      handlers.onStatus("offline");
      void flushAndReleaseMatrixSyncStore(
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

export function createMatrixPairingTransport(
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

export async function verifyAndPinGatewayDevice(
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

export async function waitForOwnMatrixDeviceKeys(
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

export function withMatrixTimeout<T>(
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
    const toolGroup = parseToolGroupPresentation(ui);
    if (effectiveExtension.ui !== undefined && !toolGroup) return null;
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
  if (effectiveExtension.kind === "extension_view") {
    const presentation = parseExtensionViewPresentation(effectiveExtension);
    if (
      !presentation ||
      typeof effectiveExtension.interaction_id !== "string" ||
      !effectiveExtension.interaction_id
    ) return null;
    return {
      eventId,
      sender,
      timestamp,
      encrypted,
      ...collaborationMetadata,
      kind: "permission",
      text: presentation.view.title,
      format: "plain",
      requestId: effectiveExtension.interaction_id,
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
  return null;
}

type DecodedHistoricalEvent = {
  gatewaySessionId?: string | null;
  message?: IncomingCodeverMessage;
};

function isGatewaySecureEnvelopeExtension(
  extension: Record<string, unknown> | null,
): boolean {
  return Boolean(
    (extension?.kind === "secure_envelope" && extension.secure_envelope) ||
      (extension?.kind === "secure_envelope_bundle" &&
        extension.secure_envelope_bundle),
  );
}

function isGatewayTimelineEnvelopeExtension(
  extension: Record<string, unknown> | null,
): boolean {
  return Boolean(
    extension?.version === 2 &&
      extension.kind === "timeline_envelope" &&
      extension.timeline_envelope,
  );
}

async function openGatewayTimelineContent(
  extension: Record<string, unknown>,
  outerContent: Record<string, unknown>,
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  trust: TrustedGateway,
  replayStore: ReplayStore,
  historical: boolean,
): Promise<Record<string, unknown> | null> {
  const signed = signedMatrixTimelineEnvelopeSchema.parse(
    extension.timeline_envelope,
  );
  let key = await loadTimelineKey(config, identity, signed.envelope.epochId);
  if (!key && extension.timeline_key_ring_bundle) {
    const bundle = signedSecureEnvelopeBundleSchema.parse(
      extension.timeline_key_ring_bundle,
    );
    const certificate = trust.certificate.certificate;
    const addressed = bundle.bundle.recipients.some(
      (recipient) =>
        recipient.recipientDeviceId === certificate.deviceId &&
        recipient.recipientKeyId === identity.keyId,
    );
    if (!addressed) return null;
    const openedGrant = await openSecureEnvelopeBundle(
      extension.timeline_key_ring_bundle,
      {
        recipientPrivateKey: identity.privateKey,
        senderPublicKey: trust.gatewayKey.publicKey,
        expected: {
          gatewayId: trust.gatewayId,
          conversationId: config.conversationId,
          direction: "gateway_to_device",
          senderDeviceId: certificate.gatewayId,
          recipientDeviceId: certificate.deviceId,
          senderKeyId: trust.gatewayKey.keyId,
          recipientKeyId: identity.keyId,
        },
        replayStore,
        ...(historical ? { now: bundle.bundle.issuedAt } : {}),
      },
    );
    await saveTimelineKeyRing(config, identity, openedGrant.plaintext);
    key = await loadTimelineKey(config, identity, signed.envelope.epochId);
  }
  if (!key) return null;
  const opened = await openMatrixTimelineEnvelope(extension.timeline_envelope, {
    timelineKey: key,
    gatewayPublicKey: trust.gatewayKey.publicKey,
    expected: {
      gatewayId: config.gatewayId,
      conversationId: config.conversationId,
      roomId: config.roomId,
      epochId: signed.envelope.epochId,
      ...(signed.envelope.sessionId
        ? { sessionId: signed.envelope.sessionId }
        : {}),
      ...(signed.envelope.threadRootEventId
        ? { threadRootEventId: signed.envelope.threadRootEventId }
        : {}),
    },
  });
  const content = asRecord(opened.plaintext);
  if (!content) throw new Error("The timeline envelope did not contain Matrix content.");
  const decryptedExtension = asRecord(content["io.codever"]);
  const sessionId =
    typeof decryptedExtension?.session_id === "string"
      ? decryptedExtension.session_id
      : undefined;
  if (sessionId !== signed.envelope.sessionId) {
    throw new Error("The timeline envelope session binding does not match its content.");
  }
  const innerRelation = content["m.relates_to"];
  const outerRelation = outerContent["m.relates_to"];
  if (canonicalJson(innerRelation ?? null) !== canonicalJson(outerRelation ?? null)) {
    throw new Error("The Matrix homeserver changed a signed timeline relation.");
  }
  const relation = asRecord(innerRelation);
  const contentThreadRoot =
    relation?.rel_type === "m.thread" && typeof relation.event_id === "string"
      ? relation.event_id
      : typeof decryptedExtension?.thread_root_event_id === "string"
        ? decryptedExtension.thread_root_event_id
        : undefined;
  if (contentThreadRoot !== signed.envelope.threadRootEventId) {
    throw new Error("The timeline envelope thread binding does not match its content.");
  }
  return content;
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
  event: MatrixEvent,
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  trust: TrustedGateway | null,
  replayStore: ReplayStore,
): Promise<DecodedHistoricalEvent | null> {
  const eventId = event.getId();
  const sender = event.getSender();
  if (!eventId || !sender || sender === config.userId || !trust) return null;
  if (event.isEncrypted() || event.getType() !== "m.room.message") {
    return null;
  }
  const content = asRecord(event.getContent());
  const extension = asRecord(content?.["io.codever"]);
  if (!content || !isGatewayTimelineEnvelopeExtension(extension)) {
    return null;
  }
  if (sender !== trust.gatewayTransport.userId) {
    return null;
  }
  const plaintext = await openGatewayTimelineContent(
    extension,
    content,
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
  const native = matrixNativeContentSchema.safeParse(decryptedExtension);
  if (native.success) {
    return native.data.kind === "session_root"
      ? { gatewaySessionId: native.data.session_id }
      : null;
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
  onNativeContent?: (
    content: MatrixNativeContent,
    eventId: string,
  ) => Promise<void>,
  onNativeSessionStatus?: (extension: Record<string, unknown>) => Promise<void>,
  historical = false,
  onCapabilityRenewalOffer?: (offer: CapabilityRenewalOffer) => void,
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
  const acceptedEnvelope = applicationControl
    ? isGatewaySecureEnvelopeExtension(extension)
    : !event.isEncrypted() && isGatewayTimelineEnvelopeExtension(extension);
  if (
    !acceptedEnvelope ||
    !identity ||
    !getTrust ||
    !replayStore
  ) {
    // Pairing and signed device rotation are the only non-envelope control
    // events. Timeline traffic must use v2 application encryption; command
    // traffic must use the dedicated application-control event type.
    seen.add(eventId);
    return;
  }
  const trust = getTrust();
  if (!trust) {
    seen.add(eventId);
    return;
  }
  if (!applicationControl && sender !== trust.gatewayTransport.userId) {
    throw new Error(
      "Rejected a Codever timeline event outside the pinned Gateway transport.",
    );
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
    plaintext = !applicationControl
      ? await openGatewayTimelineContent(
          extension,
          content,
          config,
          identity,
          trust,
          replayStore,
          historical,
        ) as JsonValue | null
      : await openGatewaySecureEnvelope(
          extension,
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
    if (!applicationControl) {
      return;
    }
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
  if (decryptedExtension?.kind === "timeline_key_ring_grant") {
    await saveTimelineKeyRing(
      config,
      identity,
      decryptedExtension.timeline_key_ring_grant,
    );
    seen.add(eventId);
    return;
  }
  const capabilityRenewalOffer = capabilityRenewalOfferSchema.safeParse(
    decryptedExtension,
  );
  if (capabilityRenewalOffer.success) {
    onCapabilityRenewalOffer?.(capabilityRenewalOffer.data);
    seen.add(eventId);
    return;
  }
  const nativeContent = matrixNativeContentSchema.safeParse(decryptedExtension);
  if (nativeContent.success) {
    await onNativeContent?.(nativeContent.data, eventId);
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
  if (decryptedExtension?.kind === "status") {
    await onNativeSessionStatus?.(decryptedExtension);
  }
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

export async function recoverGatewayTransportSnapshot(
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

export function gatewayPin(config: MatrixConnectionConfig): {
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

export function waitForInitialSync(
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
    const request = indexedDB.open(MATRIX_IDENTITY_DATABASE_NAME, 3);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DEVICE_STORE)) {
        request.result.createObjectStore(DEVICE_STORE);
      }
      if (!request.result.objectStoreNames.contains(COMMAND_SEQUENCE_STORE)) {
        request.result.createObjectStore(COMMAND_SEQUENCE_STORE);
      }
      if (!request.result.objectStoreNames.contains(TIMELINE_KEY_STORE)) {
        request.result.createObjectStore(TIMELINE_KEY_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open the device key store."));
  });
}

export async function ensureMatrixIdentityDatabase(): Promise<void> {
  const database = await openIdentityDatabase();
  try {
    for (const store of [DEVICE_STORE, COMMAND_SEQUENCE_STORE, TIMELINE_KEY_STORE]) {
      if (!database.objectStoreNames.contains(store)) {
        throw new Error(`The Matrix identity database is missing ${store}.`);
      }
    }
  } finally {
    database.close();
  }
}

function timelineKeyScope(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
): string {
  return JSON.stringify([
    "matrix-timeline-keys-v2",
    config.gatewayId,
    config.conversationId,
    config.roomId,
    identity.keyId,
  ]);
}

function matrixDirectoryStateKey(
  value: {
    state_key_prefix: string;
    slot?: number;
    directory_slot?: number;
  },
  pageIndex: number,
): string {
  const slot = value.slot ?? value.directory_slot;
  if (slot === undefined) throw new Error("Matrix directory slot is unavailable.");
  return `${value.state_key_prefix}.${slot}.${pageIndex}`;
}

function sameMatrixDirectory(left: MatrixGatewayState, right: MatrixGatewayState): boolean {
  return left.gateway_id === right.gateway_id &&
    left.conversation_id === right.conversation_id &&
    left.revision_epoch_generation === right.revision_epoch_generation &&
    left.revision_epoch === right.revision_epoch &&
    canonicalJson(left.session_directory) === canonicalJson(right.session_directory);
}

function validateMatrixDirectory(
  gateway: MatrixGatewayState,
  pages: readonly MatrixSessionDirectoryPage[],
): void {
  const descriptor = gateway.session_directory;
  if (pages.length !== descriptor.page_count) {
    throw new Error("The Matrix session directory page count is incomplete.");
  }
  const sessionIds = new Set<string>();
  pages.forEach((page, pageIndex) => {
    if (
      page.gateway_id !== gateway.gateway_id ||
      page.conversation_id !== gateway.conversation_id ||
      page.revision_epoch_generation !== gateway.revision_epoch_generation ||
      page.revision_epoch !== gateway.revision_epoch ||
      page.state_version !== descriptor.state_version ||
      page.directory_generation !== descriptor.generation ||
      page.directory_slot !== descriptor.slot ||
      page.directory_digest !== descriptor.digest ||
      page.state_key_prefix !== descriptor.state_key_prefix ||
      page.page_index !== pageIndex ||
      page.page_count !== descriptor.page_count
    ) {
      throw new Error(`Matrix session directory page ${pageIndex} does not match its Gateway commit.`);
    }
    for (const session of page.sessions) {
      if (sessionIds.has(session.session_id)) {
        throw new Error(`Matrix session directory repeats session ${session.session_id}.`);
      }
      sessionIds.add(session.session_id);
    }
  });
}

async function saveTimelineKeyRing(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  value: unknown,
): Promise<void> {
  const grant = matrixTimelineKeyRingGrantSchema.parse(value);
  if (
    grant.gateway_id !== config.gatewayId ||
    grant.conversation_id !== config.conversationId ||
    grant.room_id !== config.roomId
  ) {
    throw new Error("The timeline key grant is bound to another Matrix room.");
  }
  const database = await openIdentityDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(TIMELINE_KEY_STORE, "readwrite");
      transaction.objectStore(TIMELINE_KEY_STORE).put(
        structuredClone(grant),
        timelineKeyScope(config, identity),
      );
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        transaction.error ?? new Error("Could not save Matrix timeline keys."),
      );
      transaction.onabort = () => reject(
        transaction.error ?? new Error("Could not save Matrix timeline keys."),
      );
    });
  } finally {
    database.close();
  }
}

async function loadTimelineKey(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  epochId: string,
): Promise<Uint8Array | null> {
  const database = await openIdentityDatabase();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = database
        .transaction(TIMELINE_KEY_STORE, "readonly")
        .objectStore(TIMELINE_KEY_STORE)
        .get(timelineKeyScope(config, identity));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(
        request.error ?? new Error("Could not read Matrix timeline keys."),
      );
    });
    if (value === undefined) return null;
    const grant = matrixTimelineKeyRingGrantSchema.parse(value);
    if (
      grant.gateway_id !== config.gatewayId ||
      grant.conversation_id !== config.conversationId ||
      grant.room_id !== config.roomId
    ) {
      throw new Error("Stored Matrix timeline keys are bound to another room.");
    }
    const epoch = grant.epochs.find((candidate) => candidate.epoch_id === epochId);
    return epoch ? base64UrlDecode(epoch.key) : null;
  } finally {
    database.close();
  }
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

function capabilityRenewalMigrationScope(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
): string {
  return JSON.stringify([
    "capability-renewal-migration-v1",
    config.gatewayId,
    identity.keyId,
    config.conversationId,
  ]);
}

async function saveCapabilityRenewalMigration(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  previousSequenceEpoch: string,
): Promise<void> {
  const database = await openIdentityDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        COMMAND_SEQUENCE_STORE,
        "readwrite",
      );
      transaction.objectStore(COMMAND_SEQUENCE_STORE).put(
        {
          version: 1,
          previousSequenceEpoch,
          createdAt: Date.now(),
        } satisfies CapabilityRenewalMigration,
        capabilityRenewalMigrationScope(config, identity),
      );
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        transaction.error ??
          new Error("Could not save the device permission migration."),
      );
      transaction.onabort = () => reject(
        transaction.error ??
          new Error("Could not save the device permission migration."),
      );
    });
  } finally {
    database.close();
  }
}

async function readCapabilityRenewalMigration(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
): Promise<CapabilityRenewalMigration | null> {
  const database = await openIdentityDatabase();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = database
        .transaction(COMMAND_SEQUENCE_STORE, "readonly")
        .objectStore(COMMAND_SEQUENCE_STORE)
        .get(capabilityRenewalMigrationScope(config, identity));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(
        request.error ??
          new Error("Could not read the device permission migration."),
      );
    });
    const record = asRecord(value);
    if (!record) return null;
    if (
      record.version !== 1 ||
      typeof record.previousSequenceEpoch !== "string" ||
      !record.previousSequenceEpoch ||
      typeof record.createdAt !== "number" ||
      !Number.isSafeInteger(record.createdAt)
    ) {
      throw new Error("The device permission migration record is corrupt.");
    }
    return {
      version: 1,
      previousSequenceEpoch: record.previousSequenceEpoch,
      createdAt: record.createdAt,
    };
  } finally {
    database.close();
  }
}

async function clearCapabilityRenewalMigration(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
): Promise<void> {
  const database = await openIdentityDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        COMMAND_SEQUENCE_STORE,
        "readwrite",
      );
      transaction
        .objectStore(COMMAND_SEQUENCE_STORE)
        .delete(capabilityRenewalMigrationScope(config, identity));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        transaction.error ??
          new Error("Could not complete the device permission migration."),
      );
      transaction.onabort = () => reject(
        transaction.error ??
          new Error("Could not complete the device permission migration."),
      );
    });
  } finally {
    database.close();
  }
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

async function migratePendingCommandSequenceEpoch(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  previousSequenceEpoch: string,
  nextSequenceEpoch: string,
  expectedCommandId?: string,
): Promise<{
  reservation: CommandReservation;
  payload: CommandPayload;
} | null> {
  if (previousSequenceEpoch === nextSequenceEpoch) return null;
  const database = await openIdentityDatabase();
  const previousScope = commandSequenceScope(
    config,
    identity,
    previousSequenceEpoch,
  );
  const nextScope = commandSequenceScope(config, identity, nextSequenceEpoch);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(
        COMMAND_SEQUENCE_STORE,
        "readwrite",
      );
      const store = transaction.objectStore(COMMAND_SEQUENCE_STORE);
      const previousRead = store.get(previousScope);
      const nextRead = store.get(nextScope);
      let reads = 0;
      let failure: Error | null = null;
      let migrated: {
        reservation: CommandReservation;
        payload: CommandPayload;
      } | null = null;
      const prepare = () => {
        reads += 1;
        if (reads !== 2) return;
        try {
          const previous = parseCommandSequenceState(previousRead.result);
          const next = parseCommandSequenceState(nextRead.result);
          const pending = previous.pending;
          if (!pending) return;
          if (expectedCommandId && pending.commandId !== expectedCommandId) {
            throw new Error(
              `Refusing to migrate command ${expectedCommandId}; command ${pending.commandId} is pending instead.`,
            );
          }
          if (pending.completion) {
            throw new Error(
              "A completed command cannot be migrated to another device certificate.",
            );
          }
          if (!next.revisionInitialized || !next.revisionEpoch) {
            throw new Error(
              "Waiting for the current Gateway session state under the renewed device certificate.",
            );
          }
          if (next.pending) {
            throw new Error(
              "The renewed device certificate already has a pending command.",
            );
          }
          const reservation: CommandReservation = {
            commandId: pending.commandId,
            sequence: next.lastAcknowledged + 1,
            baseRevision: next.lastRevision,
            revisionEpoch: next.revisionEpoch,
          };
          const payload = structuredClone(pending.payload);
          store.put(
            { ...previous, pending: undefined } satisfies CommandSequenceState,
            previousScope,
          );
          store.put(
            {
              ...next,
              pending: {
                ...reservation,
                createdAt: Date.now(),
                payload,
                needsSigning: true,
              },
            } satisfies CommandSequenceState,
            nextScope,
          );
          migrated = { reservation, payload };
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          transaction.abort();
        }
      };
      previousRead.onsuccess = prepare;
      nextRead.onsuccess = prepare;
      previousRead.onerror = () => transaction.abort();
      nextRead.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve(migrated);
      transaction.onerror = () => reject(
        failure ??
          transaction.error ??
          new Error("Could not migrate the durable command outbox."),
      );
      transaction.onabort = () => reject(
        failure ??
          transaction.error ??
          new Error("Could not migrate the durable command outbox."),
      );
    });
  } finally {
    database.close();
  }
}

async function preparePendingCommandPlaintext(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  sequenceEpoch: string,
  reservation: CommandReservation,
  payload: CommandPayload,
): Promise<Record<string, unknown>> {
  try {
    const envelope = await createSignedCommand(
      config,
      identity,
      payload,
      Date.now(),
      reservation,
      sequenceEpoch,
    );
    const plaintext = {
      msgtype: "m.text",
      body: fallbackBody(payload),
      "io.codever": {
        version: 1,
        kind: "signed_command",
        signed_command: envelope,
      },
    };
    await savePendingCommandPlaintext(
      config,
      identity,
      sequenceEpoch,
      reservation.commandId,
      plaintext,
    );
    return plaintext;
  } catch (error) {
    await abandonIncompleteCommand(
      config,
      identity,
      sequenceEpoch,
      reservation.commandId,
    );
    throw error;
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
          needsSigning: undefined,
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
          const epochStatus = classifyGatewayStateEpoch(
            epochState?.revisionEpoch,
            epochState?.revisionEpochGeneration,
            epochState?.retiredRevisionEpochs ?? [],
            revisionEpoch,
            revisionEpochGeneration,
          );
          // Recovery may observe authenticated older Room State versions. They
          // are stale state, not fatal connection errors, and must never replace
          // a newer durable projection.
          if (isIgnorableGatewayStateReplay(epochStatus)) return;
          if (epochStatus === "conflict") {
            throw new Error(
              "Rejected a Gateway state snapshot that changed epoch without advancing its generation.",
            );
          }
          const sameEpoch =
            epochState !== null && epochStatus === "current";
          const baselineStateVersion =
            epochState?.stateVersion ?? state.stateVersion;
          const baselineRevision =
            epochState?.revision ?? state.lastRevision;
          const progress = sameEpoch
            ? classifyGatewayStateProgress(
                {
                  stateVersion: baselineStateVersion,
                  revision: baselineRevision,
                },
                { stateVersion, revision },
              )
            : "advance";
          if (isIgnorableGatewayStateReplay(epochStatus, progress)) return;
          const retiredRevisionEpochs = sameEpoch
            ? epochState.retiredRevisionEpochs
            : [
                ...new Set([
                  ...(epochState?.retiredRevisionEpochs ?? []),
                  ...(epochState?.revisionEpoch
                    ? [epochState.revisionEpoch]
                    : []),
                ]),
              ];
          const commandAlreadyCurrent =
            epochState !== null &&
            state.revisionInitialized &&
            state.revisionEpoch === revisionEpoch &&
            (state.revisionEpochGeneration === undefined ||
              state.revisionEpochGeneration === revisionEpochGeneration);
          const durableStateChanged =
            epochState === null ||
            !commandAlreadyCurrent ||
            !sameEpoch ||
            progress === "advance";
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
  completion?: CommandCompletion;
} | null> {
  const scope = commandSequenceScope(config, identity, sequenceEpoch);
  const state = await readCommandSequenceState(scope);
  const pending = state.pending;
  if (!pending) {
    if (expectedCommandId) {
      throw new CommandRecoveryNotFoundError(
        expectedCommandId,
        `The durable command ${expectedCommandId} is no longer pending.`,
      );
    }
    return null;
  }
  if (expectedCommandId && pending.commandId !== expectedCommandId) {
    throw new CommandRecoveryNotFoundError(
      expectedCommandId,
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
  if (pending.completion) {
    return {
      eventId: `$codever.durable.${pending.commandId}`,
      payload: pending.payload,
      reservation: pending,
      completion: pending.completion,
    };
  }
  const certificate = trust.certificate.certificate;
  const secureEnvelope = await sealSecureEnvelope({
    plaintext: pending.plaintext as JsonValue,
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
  } as unknown as RoomMessageEventContent;
  const eventId = await sendCodeverApplicationControlEvent(
    client,
    config.roomId,
    content,
    `codever.command.${pending.commandId}.retry.${crypto.randomUUID()}`,
  );
  return {
    eventId,
    payload: pending.payload,
    reservation: pending,
  };
}

export async function sendCodeverApplicationControlEvent(
  client: MatrixClient,
  roomId: string,
  content: RoomMessageEventContent,
  transactionId: string,
): Promise<string> {
  const path = [
    "/rooms/",
    encodeURIComponent(roomId),
    "/send/",
    encodeURIComponent(CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE),
    "/",
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
      ...(pending.needsSigning === true ? { needsSigning: true } : {}),
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
