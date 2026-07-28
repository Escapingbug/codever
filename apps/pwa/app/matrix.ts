import type {
  CodeverCommand,
  CommandPayload,
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
};

type PendingOutboundCommand = CommandReservation & {
  createdAt: number;
  payload: CommandPayload;
  plaintext?: Record<string, unknown>;
};

type CommandSequenceState = {
  lastAcknowledged: number;
  lastRevision: number;
  pending?: PendingOutboundCommand;
};

export type IncomingCodeverMessage = {
  eventId: string;
  sender: string;
  timestamp: number;
  encrypted: boolean;
  kind: "agent" | "user" | "tool" | "permission" | "notice" | "error";
  text: string;
  commandId?: string;
  revision?: number;
  originDeviceId?: string;
  originDeviceName?: string;
  activeDeviceCount?: number;
  requestId?: string;
  streamId?: string;
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
};

export type CommandResultState = CommandCompletion;

export type CommandSendResult = {
  eventId: string;
  commandId: string;
  sequence: number;
  revision: number;
  completion: Promise<CommandCompletion>;
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

function normalizeHomeserver(value: string): string {
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
    sequence: reservation.sequence,
    baseRevision: reservation.baseRevision,
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
  const onCommandAcknowledged = async (
    commandId: string,
    sequence: number,
    revision: number,
    activeDeviceCount?: number,
  ): Promise<void> => {
    const trust = activeTrust;
    if (!trust) return;
    await acknowledgePendingCommand(
      config,
      identity,
      trust.certificate.certificate.certificateId,
      { commandId, sequence, baseRevision: revision },
      revision,
    );
    commandLifecycle.recordAcknowledgement(commandId, sequence, revision);
    handlers.onCollaborationState?.({
      revision,
      ...(activeDeviceCount ? { activeDeviceCount } : {}),
    });
  };
  const onRevisionConflict = async (
    commandId: string,
    expectedRevision: number,
    activeDeviceCount?: number,
  ): Promise<void> => {
    const trust = activeTrust;
    if (!trust) return;
    await recordKnownRevision(
      config,
      identity,
      trust.certificate.certificate.certificateId,
      expectedRevision,
    );
    revisionConflicts.set(commandId, expectedRevision);
    handlers.onCollaborationState?.({
      revision: expectedRevision,
      ...(activeDeviceCount ? { activeDeviceCount } : {}),
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
    activeDeviceCount?: number,
  ): Promise<void> => {
    // Persist the implicit acknowledgement before waking either sender waiter.
    // This single IndexedDB transaction clears pending and advances both
    // device sequence and Gateway revision even if the explicit ack is lost.
    await onCommandAcknowledged(
      result.commandId,
      result.sequence,
      result.revision,
      activeDeviceCount,
    );
    commandLifecycle.recordResult(result);
    handlers.onCommandResult?.(result);
  };
  const onKnownRevision = async (
    revision: number,
    activeDeviceCount?: number,
  ): Promise<void> => {
    const trust = activeTrust;
    if (trust) {
      await recordKnownRevision(
        config,
        identity,
        trust.certificate.certificate.certificateId,
        revision,
      );
    }
    handlers.onCollaborationState?.({
      revision,
      ...(activeDeviceCount ? { activeDeviceCount } : {}),
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
    ...(isPositiveInteger(effectiveExtension.revision)
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
    activeDeviceCount?: number,
  ) => Promise<void>,
  onRevisionConflict?: (
    commandId: string,
    expectedRevision: number,
    activeDeviceCount?: number,
  ) => Promise<void>,
  onKnownRevision?: (
    revision: number,
    activeDeviceCount?: number,
  ) => Promise<void>,
  onCommandResult?: (
    result: CommandResultState,
    activeDeviceCount?: number,
  ) => Promise<void>,
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
  if (
    decryptedExtension?.kind === "command_ack" &&
    typeof decryptedExtension.command_id === "string" &&
    typeof decryptedExtension.sequence === "number" &&
    Number.isSafeInteger(decryptedExtension.sequence) &&
    decryptedExtension.sequence > 0 &&
    isPositiveInteger(decryptedExtension.revision)
  ) {
    await onCommandAcknowledged?.(
      decryptedExtension.command_id,
      decryptedExtension.sequence,
      decryptedExtension.revision,
      isPositiveInteger(decryptedExtension.active_device_count)
        ? decryptedExtension.active_device_count
        : undefined,
    );
    seen.add(eventId);
    return;
  }
  if (
    decryptedExtension?.kind === "revision_conflict" &&
    typeof decryptedExtension.command_id === "string" &&
    isNonnegativeInteger(decryptedExtension.expected_revision)
  ) {
    await onRevisionConflict?.(
      decryptedExtension.command_id,
      decryptedExtension.expected_revision,
      isPositiveInteger(decryptedExtension.active_device_count)
        ? decryptedExtension.active_device_count
        : undefined,
    );
    seen.add(eventId);
    return;
  }
  if (
    decryptedExtension?.kind === "command_result" &&
    typeof decryptedExtension.command_id === "string" &&
    isPositiveInteger(decryptedExtension.sequence) &&
    isPositiveInteger(decryptedExtension.revision) &&
    (decryptedExtension.outcome === "succeeded" ||
      decryptedExtension.outcome === "failed")
  ) {
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
      },
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
  if (parsed.revision) {
    await onKnownRevision?.(parsed.revision, parsed.activeDeviceCount);
  }
  onMessage(parsed);
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
): Promise<void> {
  await updateCommandSequenceState(
    commandSequenceScope(config, identity, sequenceEpoch),
    (state) => {
      if (state.lastAcknowledged >= reservation.sequence) {
        return {
          ...state,
          lastRevision: Math.max(state.lastRevision, revision),
        };
      }
      if (!state.pending) {
        return {
          lastAcknowledged: reservation.sequence,
          lastRevision: Math.max(state.lastRevision, revision),
        };
      }
      if (
        state.pending.commandId === reservation.commandId &&
        state.pending.sequence === reservation.sequence
      ) {
        return {
          lastAcknowledged: reservation.sequence,
          lastRevision: Math.max(state.lastRevision, revision),
        };
      }
      // A historical acknowledgement for a different command must not clear
      // the current outbox reservation.
      return state;
    },
  );
}

async function recordKnownRevision(
  config: MatrixConnectionConfig,
  identity: DeviceIdentity,
  sequenceEpoch: string,
  revision: number,
): Promise<void> {
  await updateCommandSequenceState(
    commandSequenceScope(config, identity, sequenceEpoch),
    (state) => ({
      ...state,
      lastRevision: Math.max(state.lastRevision, revision),
    }),
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
            lastAcknowledged: state.lastAcknowledged,
            lastRevision: state.lastRevision,
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
            lastAcknowledged: state.lastAcknowledged,
            lastRevision: state.lastRevision,
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
  if (!pending.plaintext) {
    if (Date.now() - pending.createdAt < INCOMPLETE_OUTBOX_LEASE_MS) {
      throw new Error("Another tab is preparing a Codever command.");
    }
    await updateCommandSequenceState(scope, (current) =>
      current.pending?.commandId === pending.commandId
        ? {
            lastAcknowledged: current.lastAcknowledged,
            lastRevision: current.lastRevision,
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
    return { lastAcknowledged: value, lastRevision: 0 };
  }
  const record = asRecord(value);
  const lastAcknowledged = record?.lastAcknowledged;
  if (
    typeof lastAcknowledged !== "number" ||
    !Number.isSafeInteger(lastAcknowledged) ||
    lastAcknowledged < 0
  ) {
    return { lastAcknowledged: 0, lastRevision: 0 };
  }
  const lastRevision =
    typeof record?.lastRevision === "number" &&
    Number.isSafeInteger(record.lastRevision) &&
    record.lastRevision >= 0
      ? record.lastRevision
      : 0;
  const pending = asRecord(record?.pending);
  if (!pending) return { lastAcknowledged, lastRevision };
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
    pending: {
      commandId: pending.commandId,
      sequence: pending.sequence,
      baseRevision:
        typeof pending.baseRevision === "number" &&
        Number.isSafeInteger(pending.baseRevision) &&
        pending.baseRevision >= 0
          ? pending.baseRevision
          : lastRevision,
      createdAt: pending.createdAt,
      payload: pending.payload as CommandPayload,
      ...(asRecord(pending.plaintext)
        ? { plaintext: pending.plaintext as Record<string, unknown> }
        : {}),
    },
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
