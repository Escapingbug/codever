import type {
  CodeverCommand,
  CommandPayload,
  SignedCommand,
} from "@codever/protocol";
import { generateDeviceKeyPair, signCommand } from "@codever/security";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";

export const MATRIX_CONFIG_STORAGE_KEY = "codever.matrix.connection.v1";
const DEVICE_DATABASE = "codever-pwa-identity";
const DEVICE_STORE = "keys";
const DEVICE_KEY = "p256-v1";
const COMMAND_TTL_MS = 2 * 60_000;

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

export type IncomingCodeverMessage = {
  eventId: string;
  sender: string;
  timestamp: number;
  encrypted: boolean;
  kind: "agent" | "tool" | "permission" | "notice" | "error";
  text: string;
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

export type MatrixConnection = {
  readonly identity: DeviceIdentity;
  readonly matrixDeviceKeys: {
    ed25519: string;
    curve25519: string;
  };
  readonly client: MatrixClient;
  send(payload: CommandPayload): Promise<string>;
  stop(): void;
};

export function normalizeMatrixConfig(
  input: MatrixConnectionConfig,
): MatrixConnectionConfig {
  const homeserver = input.homeserver.trim().replace(/\/+$/, "");
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

export async function createSignedCommand(
  configInput: MatrixConnectionConfig,
  identity: DeviceIdentity,
  payload: CommandPayload,
  now = Date.now(),
): Promise<SignedCommand> {
  const config = normalizeMatrixConfig(configInput);
  const command: CodeverCommand = {
    kind: "codever.command",
    version: 1,
    commandId: crypto.randomUUID(),
    gatewayId: config.gatewayId,
    deviceId: config.matrixDeviceId,
    conversationId: config.conversationId,
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
  },
): Promise<MatrixConnection> {
  const config = normalizeMatrixConfig(configInput);
  const identity = await getOrCreateDeviceIdentity();
  const sdk = await import("matrix-js-sdk");
  const client = sdk.createClient({
    baseUrl: config.homeserver,
    userId: config.userId,
    accessToken: config.accessToken,
    deviceId: config.matrixDeviceId,
    timelineSupport: true,
  });

  let stopped = false;
  let matrixDeviceKeys: { ed25519: string; curve25519: string } | null = null;
  const seen = new Set<string>();
  const onTimeline = (
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline: boolean | undefined,
  ) => {
    if (stopped || !room || room.roomId !== config.roomId || toStartOfTimeline) {
      return;
    }
    void forwardEvent(client, event, seen, config, handlers.onMessage).catch((error) => {
      handlers.onStatus("error", formatError(error));
    });
  };
  const onSync = (state: string) => {
    if (stopped) return;
    if (state === "SYNCING" || state === "PREPARED") {
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
    await client.initRustCrypto({
      useIndexedDB: true,
      cryptoDatabasePrefix: cryptoDatabasePrefix(config),
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
      const devices = await cryptoApi.getUserDeviceInfo(
        [configuredGateway.userId],
        true,
      );
      const device = devices
        .get(configuredGateway.userId)
        ?.get(configuredGateway.deviceId);
      if (!device) {
        throw new Error("The pinned Gateway Matrix device is not visible.");
      }
      if (device.getFingerprint() !== configuredGateway.ed25519) {
        throw new Error("The Gateway Matrix Ed25519 fingerprint does not match.");
      }
      await cryptoApi.setDeviceVerified(
        configuredGateway.userId,
        configuredGateway.deviceId,
        true,
      );
    }

    for (const event of room.getLiveTimeline().getEvents()) {
      await forwardEvent(client, event, seen, config, handlers.onMessage);
    }
    handlers.onStatus("connected");
  } catch (error) {
    stopped = true;
    client.off(sdk.RoomEvent.Timeline, onTimeline);
    client.off(sdk.ClientEvent.Sync, onSync);
    client.stopClient();
    handlers.onStatus("error", formatError(error));
    throw error;
  }

  if (!matrixDeviceKeys) {
    throw new Error("Matrix device keys were not initialized.");
  }
  return {
    identity,
    matrixDeviceKeys,
    client,
    async send(payload) {
      if (stopped) throw new Error("Matrix connection is closed.");
      if (!gatewayPin(config)) {
        throw new Error(
          "Pin the Gateway Matrix user, device ID, and Ed25519 fingerprint before sending.",
        );
      }
      if (!client.isRoomEncrypted(config.roomId)) {
        throw new Error("Refusing to send to an unencrypted Matrix room.");
      }
      const envelope = await createSignedCommand(config, identity, payload);
      const response = await client.sendEvent(
        config.roomId,
        sdk.EventType.RoomMessage,
        {
          msgtype: sdk.MsgType.Text,
          body: fallbackBody(payload),
          "io.codever": {
            version: 1,
            kind: "signed_command",
            signed_command: envelope,
          },
        },
        `codever.${envelope.command.commandId}`,
      );
      return response.event_id;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      client.off(sdk.RoomEvent.Timeline, onTimeline);
      client.off(sdk.ClientEvent.Sync, onSync);
      client.stopClient();
      handlers.onStatus("offline");
    },
  };
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

  if (effectiveExtension.kind === "signed_command") return null;
  if (effectiveExtension.kind === "message") {
    const ui = asRecord(effectiveExtension.ui);
    return {
      eventId,
      sender,
      timestamp,
      encrypted,
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
  const common = { eventId, sender, timestamp, encrypted, raw: payload };

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
): Promise<void> {
  const eventId = event.getId();
  const sender = event.getSender();
  if (!eventId || !sender || seen.has(eventId)) return;
  if (event.getType() === "m.room.encrypted" || event.isEncrypted()) {
    await client.decryptEventIfNeeded(event);
  }
  if (event.isDecryptionFailure()) {
    throw new Error(`Could not decrypt Matrix event ${eventId}.`);
  }
  if (event.getType() !== "m.room.message") return;
  const content = asRecord(event.getContent());
  if (!content) return;
  const parsed = parseCodeverEvent(
    eventId,
    sender,
    event.getTs(),
    event.isEncrypted(),
    content,
  );
  seen.add(eventId);
  if (!parsed) return;
  const configuredGateway = gatewayPin(config);
  if (!configuredGateway) return;
  if (sender !== configuredGateway.userId) return;
  if (event.getClaimedEd25519Key() !== configuredGateway.ed25519) return;
  onMessage(parsed);
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
    const request = indexedDB.open(DEVICE_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DEVICE_STORE)) {
        request.result.createObjectStore(DEVICE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open the device key store."));
  });
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

function cryptoDatabasePrefix(config: MatrixConnectionConfig): string {
  const safeIdentity = `${config.userId}-${config.matrixDeviceId}`.replace(
    /[^A-Za-z0-9_-]/g,
    "_",
  );
  return `codever-matrix-${safeIdentity}`;
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

function humanizeField(value: string): string {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
