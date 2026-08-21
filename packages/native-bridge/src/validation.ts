import { BridgeProtocolError } from "./errors.js";
import {
  MUTATION_METHODS,
  NATIVE_BRIDGE_LIMITS,
  REQUEST_METHODS,
  type CapabilityRequest,
  type ClientDisconnectResult,
  type ClientBootstrapResult,
  type ClientEvent,
  type ClientMessage,
  type ClientSnapshot,
  type ClientStartResult,
  type CodeverAttachment,
  type CommandCompletion,
  type CommandReceipt,
  type CommandReleaseResult,
  type CommandView,
  type EventsDeliverNotification,
  type EventsSubscribeResult,
  type HelloParams,
  type HelloResult,
  type HistoryPageResult,
  type JsonObject,
  type JsonValue,
  type MatrixRoomBinding,
  type MatrixLoginTokenResult,
  type MethodRpcResponse,
  type PairingCompleteResult,
  type PairingPreview,
  type ParsedBridgeRequest,
  type PublicTrustState,
  type RequestMethod,
  type RpcError,
  type RpcFailure,
  type RpcId,
  type RpcResponse,
  type ToolGroupPresentation,
} from "./types.js";

const REQUEST_METHOD_SET = new Set<string>(REQUEST_METHODS);
const MUTATION_METHOD_SET = new Set<string>(MUTATION_METHODS);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RPC_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const BASE64URL_SHA256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const MATRIX_USER_ID_PATTERN = /^@[^:\s]+:[^:\s]+$/;
const MATRIX_ROOM_ID_PATTERN = /^![^:\s]+:[^\s]+$/;
const MATRIX_ED25519_PATTERN = /^[A-Za-z0-9+/]{43}=?$/;

const EVENT_TYPES = new Set([
  "client.status.changed",
  "trust.changed",
  "gateway.state.changed",
  "message.upserted",
  "message.removed",
  "command.changed",
  "attachment.changed",
  "pairing.changed",
]);

type UnknownRecord = Record<string, unknown>;

export type ParseRpcOptions = {
  maxBytes?: number;
  maxDepth?: number;
};

export type ParseMethodResponseOptions = ParseRpcOptions & {
  expectedId?: RpcId;
};

export function parseRpcRequest(
  input: string | unknown,
  options: ParseRpcOptions = {},
): ParsedBridgeRequest {
  const value = parseAndBoundJson(input, options);
  const request = strictObject(
    value,
    ["jsonrpc", "id", "method", "params"],
    "JSON-RPC request",
    "INVALID_REQUEST",
  );
  if (request.jsonrpc !== "2.0") {
    invalidRequest("jsonrpc must be exactly '2.0'.");
  }
  const id = parseRpcId(request.id);
  const method = requiredString(request.method, "method", 128);
  if (!REQUEST_METHOD_SET.has(method)) {
    throw new BridgeProtocolError(
      "METHOD_NOT_FOUND",
      `Unsupported native bridge method: ${method}`,
    );
  }
  const params = parseMethodParams(method as RequestMethod, request.params);
  return {
    jsonrpc: "2.0",
    id,
    method: method as RequestMethod,
    params,
  } as ParsedBridgeRequest;
}

export function parseHelloParams(input: unknown): HelloParams {
  const value = strictObject(
    input,
    [
      "application",
      "webBuild",
      "webInstanceId",
      "supportedProtocolVersions",
      "requiredCapabilities",
      "optionalCapabilities",
    ],
    "hello params",
  );
  if (value.application !== "codever-web") {
    invalidParams("application must be 'codever-web'.");
  }
  const supportedProtocolVersions = versionArray(
    value.supportedProtocolVersions,
    "supportedProtocolVersions",
  );
  return {
    application: "codever-web",
    webBuild: requiredString(value.webBuild, "webBuild", 256),
    webInstanceId: requiredUuid(value.webInstanceId, "webInstanceId"),
    supportedProtocolVersions,
    requiredCapabilities: capabilityArray(
      value.requiredCapabilities,
      "requiredCapabilities",
    ),
    optionalCapabilities: capabilityArray(
      value.optionalCapabilities,
      "optionalCapabilities",
    ),
  };
}

/** Strictly parses a response received by the hosted UI. */
export function parseRpcResponse(
  input: string | unknown,
  options: ParseRpcOptions = {},
): RpcResponse {
  const value = parseAndBoundJson(input, options);
  const envelope = strictObject(
    value,
    undefined,
    "JSON-RPC response",
    "INVALID_REQUEST",
  );
  if (envelope.jsonrpc !== "2.0") {
    invalidRequest("jsonrpc must be exactly '2.0'.");
  }
  const id = parseRpcId(envelope.id);
  const hasResult = Object.hasOwn(envelope, "result");
  const hasError = Object.hasOwn(envelope, "error");
  if (hasResult === hasError) {
    invalidRequest("A JSON-RPC response must contain exactly one of result or error.");
  }
  const allowedKeys = hasResult
    ? ["jsonrpc", "id", "result"]
    : ["jsonrpc", "id", "error"];
  strictObject(envelope, allowedKeys, "JSON-RPC response", "INVALID_REQUEST");
  if (hasResult) {
    return {
      jsonrpc: "2.0",
      id,
      result: parseJsonValue(envelope.result, "result"),
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    error: parseRpcError(envelope.error),
  };
}

/**
 * Strictly parses and validates the result schema for the method that issued
 * the request. Callers should prefer this over parseRpcResponse once the
 * request method is known.
 */
export function parseMethodRpcResponse<M extends RequestMethod>(
  method: M,
  input: string | unknown,
  options: ParseMethodResponseOptions = {},
): MethodRpcResponse<M> {
  const response = parseRpcResponse(input, options);
  if (options.expectedId !== undefined && response.id !== options.expectedId) {
    invalidRequest("JSON-RPC response id does not match the request id.");
  }
  if ("error" in response) return response;
  return {
    jsonrpc: "2.0",
    id: response.id,
    result: parseMethodResult(method, response.result),
  } as MethodRpcResponse<M>;
}

export function parseHelloResult(input: unknown): HelloResult {
  const value = strictObject(
    input,
    ["protocolVersion", "bridgeSessionId", "native", "capabilities", "limits"],
    "hello result",
  );
  const native = strictObject(
    value.native,
    ["runtimeVersion", "runtimeBuild", "platform"],
    "hello result native runtime",
  );
  const platform = enumValue(
    native.platform,
    "native.platform",
    ["android", "windows", "macos"],
  );
  const capabilitiesValue = strictObject(
    value.capabilities,
    undefined,
    "hello result capabilities",
  );
  const capabilities: HelloResult["capabilities"] = {};
  for (const [name, candidate] of Object.entries(capabilitiesValue)) {
    const capability = strictObject(
      candidate,
      ["version", "options"],
      `capability ${name}`,
    );
    capabilities[name] = {
      version: positiveInteger(capability.version, `${name}.version`),
      ...(capability.options === undefined
        ? {}
        : {
            options: strictObject(
              capability.options,
              undefined,
              `${name}.options`,
            ) as JsonObject,
          }),
    };
  }
  const limitsValue = strictObject(
    value.limits,
    Object.keys(NATIVE_BRIDGE_LIMITS),
    "hello result limits",
  );
  const limits = Object.fromEntries(
    Object.keys(NATIVE_BRIDGE_LIMITS).map((name) => [
      name,
      positiveInteger(limitsValue[name], `limits.${name}`),
    ]),
  ) as unknown as HelloResult["limits"];
  return {
    protocolVersion: positiveInteger(value.protocolVersion, "protocolVersion"),
    bridgeSessionId: opaqueId(value.bridgeSessionId, "bridgeSessionId"),
    native: {
      runtimeVersion: requiredString(native.runtimeVersion, "native.runtimeVersion", 256),
      runtimeBuild: requiredString(native.runtimeBuild, "native.runtimeBuild", 256),
      platform: platform as HelloResult["native"]["platform"],
    },
    capabilities,
    limits,
  };
}

export function parseEventsDeliverNotification(
  input: string | unknown,
  options: ParseRpcOptions = {},
): EventsDeliverNotification {
  const value = parseAndBoundJson(input, {
    ...options,
    maxBytes: options.maxBytes ?? NATIVE_BRIDGE_LIMITS.maxEventBatchBytes,
  });
  const notification = strictObject(
    value,
    ["jsonrpc", "method", "params"],
    "event notification",
    "INVALID_REQUEST",
  );
  if (
    notification.jsonrpc !== "2.0" ||
    notification.method !== "codever.events.deliver"
  ) {
    invalidRequest("Invalid native event notification envelope.");
  }
  const params = strictObject(
    notification.params,
    ["subscriptionId", "events"],
    "event notification params",
  );
  if (!Array.isArray(params.events)) {
    invalidParams("events must be an array.");
  }
  if (params.events.length > NATIVE_BRIDGE_LIMITS.maxEventBatchCount) {
    invalidParams("Event batch exceeds the negotiated event count limit.");
  }
  return {
    jsonrpc: "2.0",
    method: "codever.events.deliver",
    params: {
      subscriptionId: opaqueId(params.subscriptionId, "subscriptionId"),
      events: params.events.map((event, index) =>
        parseClientEvent(event, `events[${index}]`),
      ),
    },
  };
}

export function parseRpcError(input: unknown): RpcError {
  const error = strictObject(input, ["code", "message", "data"], "RPC error");
  const data = strictObject(
    error.data,
    [
      "errorCode",
      "retryable",
      "retryAfterMs",
      "operationId",
      "userAction",
      "details",
    ],
    "RPC error data",
  );
  if (!Number.isInteger(error.code)) invalidParams("error.code must be an integer.");
  if (typeof data.retryable !== "boolean") {
    invalidParams("error.data.retryable must be a boolean.");
  }
  const errorCode = requiredString(data.errorCode, "errorCode", 128);
  const allowedCodes = new Set([
    "PARSE_ERROR",
    "INVALID_REQUEST",
    "METHOD_NOT_FOUND",
    "INVALID_PARAMS",
    "BRIDGE_NOT_READY",
    "PROTOCOL_UNSUPPORTED",
    "CAPABILITY_UNAVAILABLE",
    "UNAUTHORIZED_ORIGIN",
    "STALE_WEB_INSTANCE",
    "INVALID_STATE",
    "USER_CANCELLED",
    "IDEMPOTENCY_CONFLICT",
    "OPERATION_NOT_FOUND",
    "OPERATION_NOT_RECOVERABLE",
    "OFFLINE",
    "TIMEOUT",
    "RATE_LIMITED",
    "TRUST_REQUIRED",
    "TRUST_BLOCKED",
    "PAIRING_EXPIRED",
    "PAIRING_REJECTED",
    "CURSOR_EXPIRED",
    "HISTORY_CURSOR_INVALID",
    "TRANSFER_NOT_FOUND",
    "CHUNK_CONFLICT",
    "ATTACHMENT_TOO_LARGE",
    "HASH_MISMATCH",
    "NATIVE_INTERNAL",
  ]);
  if (!allowedCodes.has(errorCode)) invalidParams("Unknown bridge errorCode.");
  const userAction = optionalEnum(
    data.userAction,
    "userAction",
    ["retry", "open_app", "repair_trust", "pair_again", "update_native"],
  );
  const retryAfterMs = optionalNonnegativeInteger(
    data.retryAfterMs,
    "retryAfterMs",
  );
  const operationId = optionalOpaqueId(data.operationId, "operationId");
  return {
    code: error.code as number,
    message: requiredString(error.message, "error.message", 2_048),
    data: {
      errorCode: errorCode as RpcError["data"]["errorCode"],
      retryable: data.retryable,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(operationId === undefined ? {} : { operationId }),
      ...(userAction === undefined
        ? {}
        : { userAction: userAction as RpcError["data"]["userAction"] }),
      ...(data.details === undefined
        ? {}
        : { details: parseJsonValue(data.details, "details") }),
    },
  };
}

export function failureResponse(
  id: RpcId | null,
  error: BridgeProtocolError | RpcError,
): RpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: error instanceof BridgeProtocolError ? error.toRpcError() : error,
  };
}

export function isRequestMethod(method: string): method is RequestMethod {
  return REQUEST_METHOD_SET.has(method);
}

export function isMutationMethod(method: string): boolean {
  return MUTATION_METHOD_SET.has(method);
}

function parseMethodResult<M extends RequestMethod>(
  method: M,
  input: unknown,
): import("./types.js").BridgeMethodResults[M] {
  let result: unknown;
  switch (method) {
    case "codever.bridge.hello":
      result = parseHelloResult(input);
      break;
    case "codever.client.start":
      result = parseClientStartResult(input);
      break;
    case "codever.client.bootstrap":
      result = parseClientBootstrapResult(input);
      break;
    case "codever.matrix.loginToken":
      result = parseMatrixLoginTokenResult(input);
      break;
    case "codever.client.snapshot":
      result = parseClientSnapshot(input);
      break;
    case "codever.client.disconnect":
      result = parseClientDisconnectResult(input);
      break;
    case "codever.events.subscribe":
      result = parseEventsSubscribeResult(input);
      break;
    case "codever.events.activate":
    case "codever.events.ack":
      result = parseEventsCursorResult(input);
      break;
    case "codever.events.unsubscribe":
      result = parseLiteralResult(
        input,
        "unsubscribed",
        "subscriptionId",
      );
      break;
    case "codever.command.send":
    case "codever.command.cancel":
    case "codever.command.recover":
    case "codever.command.resolveConflict":
      result = parseCommandReceipt(input);
      break;
    case "codever.command.get":
      result = parseCommandView(input);
      break;
    case "codever.command.release":
      result = parseLiteralResult(input, "released", "commandId");
      break;
    case "codever.history.page":
      result = parseHistoryPageResult(input);
      break;
    case "codever.attachment.upload.open":
      result = parseAttachmentUploadOpenResult(input);
      break;
    case "codever.attachment.upload.chunk":
      result = parseAttachmentUploadChunkResult(input);
      break;
    case "codever.attachment.upload.finish": {
      const value = strictObject(input, ["attachment"], "upload finish result");
      result = { attachment: parseAttachment(value.attachment) };
      break;
    }
    case "codever.attachment.upload.abort":
      result = parseLiteralResult(input, "aborted", "transferId");
      break;
    case "codever.attachment.download.open":
      result = parseAttachmentDownloadOpenResult(input);
      break;
    case "codever.attachment.download.read":
      result = parseAttachmentDownloadReadResult(input);
      break;
    case "codever.attachment.download.close":
      result = parseLiteralResult(input, "closed", "transferId");
      break;
    case "codever.pairing.inspect":
      result = parsePairingPreview(input);
      break;
    case "codever.pairing.complete":
      result = parsePairingCompleteResult(input);
      break;
    case "codever.pairing.cancel":
      result = parseLiteralResult(input, "cancelled", "pairingId");
      break;
    case "codever.trust.get":
      result = parsePublicTrustState(input, "trust result");
      break;
  }
  return result as import("./types.js").BridgeMethodResults[M];
}

function parseClientStartResult(input: unknown): ClientStartResult {
  const value = strictObject(input, ["deviceId", "snapshot"], "client start result");
  const deviceId = opaqueId(value.deviceId, "start.deviceId");
  const snapshot = parseClientSnapshot(value.snapshot);
  if (snapshot.deviceId !== deviceId) {
    invalidParams("Start result deviceId must match snapshot.deviceId.");
  }
  return { deviceId, snapshot };
}

function parseClientBootstrapResult(input: unknown): ClientBootstrapResult {
  const value = strictObject(
    input,
    ["deviceId", "session", "snapshot"],
    "client bootstrap result",
  );
  const deviceId = opaqueId(value.deviceId, "bootstrap.deviceId");
  const sessionValue = strictObject(
    value.session,
    ["homeserver", "userId", "matrixDeviceId", "roomBinding"],
    "bootstrap.session",
  );
  const snapshot = parseClientSnapshot(value.snapshot);
  if (snapshot.deviceId !== deviceId) {
    invalidParams("Bootstrap result deviceId must match snapshot.deviceId.");
  }
  return {
    deviceId,
    session: {
      homeserver: httpsHomeserver(
        sessionValue.homeserver,
        "bootstrap.session.homeserver",
      ),
      userId: matrixUserId(sessionValue.userId, "bootstrap.session.userId"),
      matrixDeviceId: opaqueId(
        sessionValue.matrixDeviceId,
        "bootstrap.session.matrixDeviceId",
      ),
      roomBinding: parseMatrixRoomBinding(
        sessionValue.roomBinding,
        "bootstrap.session.roomBinding",
      ),
    },
    snapshot,
  };
}

function parseMatrixLoginTokenResult(input: unknown): MatrixLoginTokenResult {
  const value = strictObject(input, undefined, "Matrix login token result");
  const status = requiredString(value.status, "login token status", 32);
  switch (status) {
    case "ready":
      strictObject(
        value,
        ["status", "loginToken", "expiresAt"],
        "Matrix login token result",
      );
      return {
        status,
        loginToken: requiredString(value.loginToken, "loginToken", 4_096),
        expiresAt: nonnegativeInteger(value.expiresAt, "expiresAt"),
      };
    case "reauth-required":
      strictObject(
        value,
        ["status", "passwordSupported"],
        "Matrix login token result",
      );
      return {
        status,
        passwordSupported: requiredBoolean(
          value.passwordSupported,
          "passwordSupported",
        ),
      };
    case "unsupported":
      strictObject(value, ["status"], "Matrix login token result");
      return { status };
    default:
      invalidParams("Matrix login token status is unsupported.");
  }
}

function parseClientDisconnectResult(input: unknown): ClientDisconnectResult {
  const value = strictObject(input, ["mode", "snapshot"], "disconnect result");
  return {
    mode: enumValue(value.mode, "disconnect.mode", ["stop", "revoke"]),
    snapshot: parseClientSnapshot(value.snapshot),
  };
}

function parseClientSnapshot(input: unknown): ClientSnapshot {
  const value = strictObject(
    input,
    [
      "schemaVersion",
      "deviceId",
      "cursor",
      "generatedAt",
      "lifecycle",
      "foregroundService",
      "trust",
      "gatewayState",
      "commands",
      "pairing",
    ],
    "client snapshot",
  );
  if (value.schemaVersion !== 1) invalidParams("snapshot.schemaVersion must be 1.");
  const lifecycle = strictObject(
    value.lifecycle,
    ["phase", "since", "detailCode"],
    "snapshot.lifecycle",
  );
  const foreground = strictObject(
    value.foregroundService,
    ["required", "active", "notificationVisible"],
    "snapshot.foregroundService",
  );
  if (foreground.required !== true) {
    invalidParams("snapshot.foregroundService.required must be true in v1.");
  }
  if (
    typeof foreground.active !== "boolean" ||
    typeof foreground.notificationVisible !== "boolean"
  ) {
    invalidParams("Foreground service state must contain booleans.");
  }
  if (!Array.isArray(value.commands) || value.commands.length > 1_000) {
    invalidParams("snapshot.commands must be a bounded array.");
  }
  const gatewayState = value.gatewayState === undefined
    ? undefined
    : parseJsonObject(value.gatewayState, "snapshot.gatewayState");
  const pairing = value.pairing === undefined
    ? undefined
    : parseJsonObject(value.pairing, "snapshot.pairing");
  return {
    schemaVersion: 1,
    deviceId: opaqueId(value.deviceId, "snapshot.deviceId"),
    cursor: opaqueId(value.cursor, "snapshot.cursor"),
    generatedAt: nonnegativeInteger(value.generatedAt, "snapshot.generatedAt"),
    lifecycle: {
      phase: enumValue(lifecycle.phase, "snapshot.lifecycle.phase", [
        "stopped",
        "starting",
        "unpaired",
        "connecting",
        "securing",
        "ready",
        "reconnecting",
        "offline",
        "blocked",
      ]),
      since: nonnegativeInteger(lifecycle.since, "snapshot.lifecycle.since"),
      ...(lifecycle.detailCode === undefined
        ? {}
        : { detailCode: requiredString(lifecycle.detailCode, "detailCode", 128) }),
    },
    foregroundService: {
      required: true,
      active: foreground.active,
      notificationVisible: foreground.notificationVisible,
    },
    trust: parsePublicTrustState(value.trust, "snapshot.trust"),
    ...(gatewayState === undefined ? {} : { gatewayState }),
    commands: value.commands.map((command, index) =>
      parseCommandView(command, `snapshot.commands[${index}]`),
    ),
    ...(pairing === undefined ? {} : { pairing }),
  };
}

export function parsePublicTrustState(
  input: unknown,
  label = "public trust state",
): PublicTrustState {
  const stateValue = strictObject(input, undefined, label);
  const state = requiredString(stateValue.state, `${label}.state`, 32);
  switch (state) {
    case "unpaired":
      strictObject(stateValue, ["state"], label);
      return { state: "unpaired" };
    case "pairing":
      strictObject(stateValue, ["state", "pairingId", "expiresAt"], label);
      return {
        state: "pairing",
        pairingId: opaqueId(stateValue.pairingId, `${label}.pairingId`),
        expiresAt: nonnegativeInteger(stateValue.expiresAt, `${label}.expiresAt`),
      };
    case "trusted":
      strictObject(
        stateValue,
        [
          "state",
          "gatewayId",
          "gatewayName",
          "certificateId",
          "pairedAt",
          "activeDeviceCount",
        ],
        label,
      );
      return {
        state: "trusted",
        gatewayId: opaqueId(stateValue.gatewayId, `${label}.gatewayId`),
        gatewayName: requiredString(stateValue.gatewayName, `${label}.gatewayName`, 256),
        certificateId: opaqueId(
          stateValue.certificateId,
          `${label}.certificateId`,
        ),
        pairedAt: nonnegativeInteger(stateValue.pairedAt, `${label}.pairedAt`),
        ...(stateValue.activeDeviceCount === undefined
          ? {}
          : {
              activeDeviceCount: positiveInteger(
                stateValue.activeDeviceCount,
                `${label}.activeDeviceCount`,
              ),
            }),
      };
    case "blocked":
      strictObject(stateValue, ["state", "reasonCode"], label);
      return {
        state: "blocked",
        reasonCode: requiredString(stateValue.reasonCode, `${label}.reasonCode`, 128),
      };
    default:
      invalidParams(`${label}.state has an unsupported value.`);
  }
}

function parseCommandReceipt(input: unknown): CommandReceipt {
  return parseCommandRecord(input, "command receipt", false) as CommandReceipt;
}

export function parseCommandView(
  input: unknown,
  label = "command view",
): CommandView {
  return parseCommandRecord(input, label, true) as CommandView;
}

function parseCommandRecord(
  input: unknown,
  label: string,
  allowViewFields: boolean,
): CommandReceipt | CommandView {
  const allowed = [
    "operationId",
    "commandId",
    "idempotencyKey",
    "state",
    "submittedAt",
    "updatedAt",
    "sessionId",
    "sequence",
    "revision",
    ...(allowViewFields ? ["cancelRequested", "completion"] : []),
  ];
  const value = strictObject(input, allowed, label);
  const completion = allowViewFields && value.completion !== undefined
    ? parseCommandCompletion(value.completion, `${label}.completion`)
    : undefined;
  const cancelRequested = allowViewFields && value.cancelRequested !== undefined
    ? requiredBoolean(value.cancelRequested, `${label}.cancelRequested`)
    : undefined;
  return {
    operationId: opaqueId(value.operationId, `${label}.operationId`),
    ...(value.commandId === undefined
      ? {}
      : { commandId: opaqueId(value.commandId, `${label}.commandId`) }),
    idempotencyKey: requiredUuid(value.idempotencyKey, `${label}.idempotencyKey`),
    state: enumValue(value.state, `${label}.state`, [
      "queued",
      "transmitting",
      "accepted",
      "running",
      "needs_review",
      "recovery_required",
      "succeeded",
      "failed",
      "cancelled",
    ]),
    submittedAt: nonnegativeInteger(value.submittedAt, `${label}.submittedAt`),
    updatedAt: nonnegativeInteger(value.updatedAt, `${label}.updatedAt`),
    ...(value.sessionId === undefined
      ? {}
      : { sessionId: opaqueId(value.sessionId, `${label}.sessionId`) }),
    ...(value.sequence === undefined
      ? {}
      : { sequence: positiveInteger(value.sequence, `${label}.sequence`) }),
    ...(value.revision === undefined
      ? {}
      : { revision: nonnegativeInteger(value.revision, `${label}.revision`) }),
    ...(cancelRequested === undefined ? {} : { cancelRequested }),
    ...(completion === undefined ? {} : { completion }),
  };
}

function parseCommandCompletion(input: unknown, label: string): CommandCompletion {
  const value = strictObject(
    input,
    ["commandId", "sequence", "revision", "outcome", "sessionId", "result", "error"],
    label,
  );
  const errorValue = value.error === undefined
    ? undefined
    : strictObject(
        value.error,
        ["code", "message", "retryable"],
        `${label}.error`,
      );
  return {
    commandId: opaqueId(value.commandId, `${label}.commandId`),
    sequence: positiveInteger(value.sequence, `${label}.sequence`),
    revision: nonnegativeInteger(value.revision, `${label}.revision`),
    outcome: enumValue(value.outcome, `${label}.outcome`, [
      "succeeded",
      "failed",
      "cancelled",
    ]),
    ...(value.sessionId === undefined
      ? {}
      : { sessionId: opaqueId(value.sessionId, `${label}.sessionId`) }),
    ...(value.result === undefined
      ? {}
      : { result: parseJsonValue(value.result, `${label}.result`) }),
    ...(errorValue === undefined
      ? {}
      : {
          error: {
            code: requiredString(errorValue.code, `${label}.error.code`, 128),
            message: requiredString(
              errorValue.message,
              `${label}.error.message`,
              2_048,
            ),
            retryable: requiredBoolean(
              errorValue.retryable,
              `${label}.error.retryable`,
            ),
          },
        }),
  };
}

function parseEventsSubscribeResult(input: unknown): EventsSubscribeResult {
  const initial = strictObject(input, undefined, "events subscribe result");
  const mode = enumValue(initial.mode, "subscribe.mode", ["replay", "snapshot"]);
  const base = {
    subscriptionId: opaqueId(initial.subscriptionId, "subscribe.subscriptionId"),
    barrierCursor: opaqueId(initial.barrierCursor, "subscribe.barrierCursor"),
  };
  if (mode === "replay") {
    const value = strictObject(
      initial,
      ["subscriptionId", "barrierCursor", "mode", "events"],
      "events subscribe replay result",
    );
    if (!Array.isArray(value.events)) invalidParams("subscribe.events must be an array.");
    if (value.events.length > NATIVE_BRIDGE_LIMITS.maxReplayEvents) {
      invalidParams("subscribe.events exceeds the replay limit.");
    }
    return {
      ...base,
      mode: "replay",
      events: value.events.map((event, index) =>
        parseClientEvent(event, `subscribe.events[${index}]`),
      ),
    };
  }
  const value = strictObject(
    initial,
    ["subscriptionId", "barrierCursor", "mode", "snapshot"],
    "events subscribe snapshot result",
  );
  const snapshot = parseClientSnapshot(value.snapshot);
  if (snapshot.cursor !== base.barrierCursor) {
    invalidParams("Snapshot cursor must equal the subscription barrier cursor.");
  }
  return { ...base, mode: "snapshot", snapshot };
}

function parseEventsCursorResult(input: unknown): {
  subscriptionId: string;
  throughCursor: string;
} {
  const value = strictObject(
    input,
    ["subscriptionId", "throughCursor"],
    "event cursor result",
  );
  return {
    subscriptionId: opaqueId(value.subscriptionId, "subscriptionId"),
    throughCursor: opaqueId(value.throughCursor, "throughCursor"),
  };
}

function parseHistoryPageResult(input: unknown): HistoryPageResult {
  const value = strictObject(
    input,
    ["sessionId", "messages", "nextBefore", "hasMore", "asOfCursor"],
    "history page result",
  );
  if (!Array.isArray(value.messages) || value.messages.length > 100) {
    invalidParams("history.messages must be an array of at most 100 messages.");
  }
  return {
    sessionId: opaqueId(value.sessionId, "history.sessionId"),
    messages: value.messages.map((message, index) =>
      parseClientMessage(message, `history.messages[${index}]`),
    ),
    ...(value.nextBefore === undefined
      ? {}
      : { nextBefore: opaqueId(value.nextBefore, "history.nextBefore") }),
    hasMore: requiredBoolean(value.hasMore, "history.hasMore"),
    asOfCursor: opaqueId(value.asOfCursor, "history.asOfCursor"),
  };
}

export function parseClientMessage(
  input: unknown,
  label = "client message",
): ClientMessage {
  const value = strictObject(
    input,
    [
      "eventId",
      "sender",
      "timestamp",
      "encrypted",
      "kind",
      "text",
      "sessionId",
      "historical",
      "operationId",
      "requestId",
      "replacesEventId",
      "commandId",
      "revision",
      "originDeviceId",
      "originDeviceName",
      "activeDeviceCount",
      "format",
      "attachments",
      "toolGroup",
      "semantic",
    ],
    label,
  );
  let attachments: CodeverAttachment[] | undefined;
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments) || value.attachments.length > 10) {
      invalidParams(`${label}.attachments must contain at most 10 items.`);
    }
    attachments = value.attachments.map((item) => parseAttachment(item));
  }
  const toolGroup = value.toolGroup === undefined
    ? undefined
    : parseToolGroupPresentation(value.toolGroup, `${label}.toolGroup`);
  const semantic = value.semantic === undefined
    ? undefined
    : parseJsonObject(value.semantic, `${label}.semantic`);
  const kind = enumValue(value.kind, `${label}.kind`, [
    "notice",
    "user",
    "agent",
    "tool",
    "permission",
    "error",
  ]);
  if ((kind === "tool") !== (toolGroup !== undefined)) {
    invalidParams(`${label}.toolGroup must be present only for tool messages.`);
  }
  return {
    eventId: opaqueId(value.eventId, `${label}.eventId`),
    sender: opaqueId(value.sender, `${label}.sender`),
    timestamp: nonnegativeInteger(value.timestamp, `${label}.timestamp`),
    encrypted: requiredBoolean(value.encrypted, `${label}.encrypted`),
    kind,
    ...(value.text === undefined
      ? {}
      : { text: requiredString(value.text, `${label}.text`, 2_000_000, true) }),
    ...optionalStringFields(value, label, [
      "sessionId",
      "operationId",
      "requestId",
      "replacesEventId",
      "commandId",
      "originDeviceId",
      "originDeviceName",
    ]),
    ...(value.historical === undefined
      ? {}
      : { historical: requiredBoolean(value.historical, `${label}.historical`) }),
    ...(value.revision === undefined
      ? {}
      : { revision: nonnegativeInteger(value.revision, `${label}.revision`) }),
    ...(value.activeDeviceCount === undefined
      ? {}
      : {
          activeDeviceCount: positiveInteger(
            value.activeDeviceCount,
            `${label}.activeDeviceCount`,
          ),
        }),
    format: enumValue(value.format, `${label}.format`, ["plain", "markdown", "html"]),
    ...(attachments === undefined ? {} : { attachments }),
    ...(toolGroup === undefined ? {} : { toolGroup }),
    ...(semantic === undefined ? {} : { semantic }),
  } as ClientMessage;
}

function parseToolGroupPresentation(
  input: unknown,
  label: string,
): ToolGroupPresentation {
  const value = strictObject(
    input,
    ["kind", "version", "groupId", "tools"],
    label,
  );
  if (value.kind !== "tool_group" || value.version !== 1) {
    invalidParams(`${label} must be a version 1 tool group.`);
  }
  if (!Array.isArray(value.tools) || value.tools.length > 200) {
    invalidParams(`${label}.tools must contain at most 200 items.`);
  }
  return {
    kind: "tool_group",
    version: 1,
    groupId: opaqueId(value.groupId, `${label}.groupId`),
    tools: value.tools.map((inputTool, index) => {
      const toolLabel = `${label}.tools[${index}]`;
      const tool = strictObject(
        inputTool,
        [
          "id",
          "name",
          "title",
          "detail",
          "result",
          "category",
          "phase",
          "isError",
          "startedAt",
          "updatedAt",
        ],
        toolLabel,
      );
      return {
        id: opaqueId(tool.id, `${toolLabel}.id`),
        name: requiredString(tool.name, `${toolLabel}.name`, 512),
        title: requiredString(tool.title, `${toolLabel}.title`, 512),
        ...(tool.detail === undefined
          ? {}
          : { detail: requiredString(tool.detail, `${toolLabel}.detail`, 4_096, true) }),
        ...(tool.result === undefined
          ? {}
          : { result: requiredString(tool.result, `${toolLabel}.result`, 64 * 1024, true) }),
        category: enumValue(tool.category, `${toolLabel}.category`, [
          "read",
          "edit",
          "write",
          "execute",
          "search",
          "agent",
          "unknown",
        ]),
        phase: enumValue(tool.phase, `${toolLabel}.phase`, [
          "started",
          "updated",
          "completed",
          "failed",
        ]),
        isError: requiredBoolean(tool.isError, `${toolLabel}.isError`),
        startedAt: nonnegativeInteger(tool.startedAt, `${toolLabel}.startedAt`),
        updatedAt: nonnegativeInteger(tool.updatedAt, `${toolLabel}.updatedAt`),
      };
    }),
  };
}

function parsePairingPreview(input: unknown): PairingPreview {
  const value = strictObject(
    input,
    [
      "pairingId",
      "gatewayId",
      "gatewayName",
      "verificationCode",
      "expiresAt",
      "requiresNativeConfirmation",
    ],
    "pairing preview",
  );
  if (value.requiresNativeConfirmation !== true) {
    invalidParams("Pairing must require native confirmation.");
  }
  return {
    pairingId: opaqueId(value.pairingId, "pairing.pairingId"),
    gatewayId: opaqueId(value.gatewayId, "pairing.gatewayId"),
    gatewayName: requiredString(value.gatewayName, "pairing.gatewayName", 256),
    verificationCode: requiredString(
      value.verificationCode,
      "pairing.verificationCode",
      64,
    ),
    expiresAt: nonnegativeInteger(value.expiresAt, "pairing.expiresAt"),
    requiresNativeConfirmation: true,
  };
}

function parsePairingCompleteResult(input: unknown): PairingCompleteResult {
  const value = strictObject(input, ["trust", "snapshot"], "pairing complete result");
  const trust = parsePublicTrustState(value.trust, "pairing.trust");
  if (trust.state !== "trusted") {
    invalidParams("Pairing completion must return trusted state.");
  }
  const snapshot = parseClientSnapshot(value.snapshot);
  if (snapshot.trust.state !== "trusted" || snapshot.trust.gatewayId !== trust.gatewayId) {
    invalidParams("Pairing result trust must match snapshot trust.");
  }
  return { trust, snapshot };
}

function parseAttachmentUploadOpenResult(input: unknown) {
  const value = strictObject(
    input,
    ["transferId", "chunkBytes", "nextIndex", "expiresAt"],
    "upload open result",
  );
  const chunkBytes = positiveInteger(value.chunkBytes, "upload.chunkBytes");
  if (chunkBytes > NATIVE_BRIDGE_LIMITS.attachmentChunkBytes) {
    invalidParams("upload.chunkBytes exceeds the bridge limit.");
  }
  return {
    transferId: opaqueId(value.transferId, "upload.transferId"),
    chunkBytes,
    nextIndex: nonnegativeInteger(value.nextIndex, "upload.nextIndex"),
    expiresAt: nonnegativeInteger(value.expiresAt, "upload.expiresAt"),
  };
}

function parseAttachmentUploadChunkResult(input: unknown) {
  const value = strictObject(
    input,
    ["transferId", "index", "receivedBytes", "nextIndex"],
    "upload chunk result",
  );
  const index = nonnegativeInteger(value.index, "upload.index");
  const nextIndex = nonnegativeInteger(value.nextIndex, "upload.nextIndex");
  if (nextIndex < index + 1) invalidParams("upload.nextIndex must acknowledge the chunk.");
  const receivedBytes = nonnegativeInteger(value.receivedBytes, "upload.receivedBytes");
  if (receivedBytes > NATIVE_BRIDGE_LIMITS.attachmentChunkBytes) {
    invalidParams("upload.receivedBytes exceeds the chunk limit.");
  }
  return {
    transferId: opaqueId(value.transferId, "upload.transferId"),
    index,
    receivedBytes,
    nextIndex,
  };
}

function parseAttachmentDownloadOpenResult(input: unknown) {
  const value = strictObject(
    input,
    ["transferId", "size", "sha256", "chunkBytes", "chunkCount"],
    "download open result",
  );
  const size = nonnegativeInteger(value.size, "download.size");
  if (size > NATIVE_BRIDGE_LIMITS.maxAttachmentBytes) {
    invalidParams("download.size exceeds the attachment limit.");
  }
  const chunkBytes = positiveInteger(value.chunkBytes, "download.chunkBytes");
  if (chunkBytes > NATIVE_BRIDGE_LIMITS.attachmentChunkBytes) {
    invalidParams("download.chunkBytes exceeds the bridge limit.");
  }
  const chunkCount = nonnegativeInteger(value.chunkCount, "download.chunkCount");
  if (chunkCount !== Math.ceil(size / chunkBytes)) {
    invalidParams("download.chunkCount does not match size and chunkBytes.");
  }
  return {
    transferId: opaqueId(value.transferId, "download.transferId"),
    size,
    sha256: sha256(value.sha256, "download.sha256"),
    chunkBytes,
    chunkCount,
  };
}

function parseAttachmentDownloadReadResult(input: unknown) {
  const value = strictObject(
    input,
    ["transferId", "index", "dataBase64Url", "chunkSha256", "eof"],
    "download read result",
  );
  const data = requiredString(
    value.dataBase64Url,
    "download.dataBase64Url",
    Math.ceil((NATIVE_BRIDGE_LIMITS.attachmentChunkBytes * 4) / 3) + 8,
    true,
  );
  if (!BASE64URL_PATTERN.test(data)) invalidParams("download.dataBase64Url is invalid.");
  return {
    transferId: opaqueId(value.transferId, "download.transferId"),
    index: nonnegativeInteger(value.index, "download.index"),
    dataBase64Url: data,
    chunkSha256: sha256(value.chunkSha256, "download.chunkSha256"),
    eof: requiredBoolean(value.eof, "download.eof"),
  };
}

function parseLiteralResult(
  input: unknown,
  flag: "unsubscribed" | "released" | "aborted" | "closed" | "cancelled",
  idName: "subscriptionId" | "commandId" | "transferId" | "pairingId",
): Record<string, string | true> {
  const value = strictObject(input, [idName, flag], `${flag} result`);
  if (value[flag] !== true) invalidParams(`${flag} result flag must be true.`);
  return { [idName]: opaqueId(value[idName], idName), [flag]: true };
}

function parseJsonObject(input: unknown, label: string): JsonObject {
  const value = strictObject(input, undefined, label);
  return parseJsonValue(value, label) as JsonObject;
}

function parseMatrixRoomBinding(input: unknown, label: string): MatrixRoomBinding {
  const value = strictObject(
    input,
    [
      "roomId",
      "gatewayId",
      "conversationId",
      "gatewayUserId",
      "gatewayDeviceId",
      "gatewayDeviceEd25519",
    ],
    label,
  );
  const ed25519 = requiredString(
    value.gatewayDeviceEd25519,
    `${label}.gatewayDeviceEd25519`,
    64,
  );
  if (!MATRIX_ED25519_PATTERN.test(ed25519)) {
    invalidParams(`${label}.gatewayDeviceEd25519 must be a Matrix Ed25519 key.`);
  }
  return {
    roomId: matrixRoomId(value.roomId, `${label}.roomId`),
    gatewayId: opaqueId(value.gatewayId, `${label}.gatewayId`),
    conversationId: opaqueId(value.conversationId, `${label}.conversationId`),
    gatewayUserId: matrixUserId(value.gatewayUserId, `${label}.gatewayUserId`),
    gatewayDeviceId: opaqueId(
      value.gatewayDeviceId,
      `${label}.gatewayDeviceId`,
    ),
    gatewayDeviceEd25519: ed25519,
  };
}

function httpsHomeserver(input: unknown, label: string): string {
  const value = requiredString(input, label, 2_048);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidParams(`${label} must be an absolute HTTPS URL.`);
  }
  const loopbackFixture =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (
    (url.protocol !== "https:" && !loopbackFixture) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    invalidParams(
      `${label} must be a credential-free HTTPS homeserver URL (or an explicit loopback test fixture).`,
    );
  }
  return value;
}

function matrixUserId(input: unknown, label: string): string {
  const value = requiredString(input, label, 512);
  if (!MATRIX_USER_ID_PATTERN.test(value)) {
    invalidParams(`${label} must be a Matrix user id.`);
  }
  return value;
}

function matrixRoomId(input: unknown, label: string): string {
  const value = requiredString(input, label, 512);
  if (!MATRIX_ROOM_ID_PATTERN.test(value)) {
    invalidParams(`${label} must be a Matrix room id.`);
  }
  return value;
}

function optionalStringFields(
  value: UnknownRecord,
  label: string,
  names: readonly string[],
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const name of names) {
    if (value[name] !== undefined) {
      output[name] = opaqueId(value[name], `${label}.${name}`);
    }
  }
  return output;
}

function requiredBoolean(input: unknown, label: string): boolean {
  if (typeof input !== "boolean") invalidParams(`${label} must be a boolean.`);
  return input;
}

function parseMethodParams(method: RequestMethod, input: unknown): JsonObject {
  if (method === "codever.bridge.hello") {
    return parseHelloParams(input) as unknown as JsonObject;
  }

  switch (method) {
    case "codever.client.start":
      return mutationParams(input, []);
    case "codever.client.bootstrap": {
      const params = mutationParams(input, [
        "homeserver",
        "oneTimeLoginToken",
        "password",
        "expectedUserId",
        "deviceName",
        "roomBinding",
      ]);
      httpsHomeserver(params.homeserver, "homeserver");
      const hasToken = params.oneTimeLoginToken !== undefined;
      const hasPassword = params.password !== undefined;
      if (hasToken === hasPassword) {
        invalidParams("exactly one Matrix bootstrap credential is required");
      }
      if (hasToken) {
        requiredString(params.oneTimeLoginToken, "oneTimeLoginToken", 4_096);
      }
      if (hasPassword) {
        requiredString(params.password, "password", 4_096);
      }
      matrixUserId(params.expectedUserId, "expectedUserId");
      requiredString(params.deviceName, "deviceName", 256);
      parseMatrixRoomBinding(params.roomBinding, "roomBinding");
      return params;
    }
    case "codever.matrix.loginToken": {
      const params = mutationParams(input, ["invitationId", "password"]);
      opaqueId(params.invitationId, "invitationId");
      if (params.password !== undefined) {
        requiredString(params.password, "password", 4_096);
      }
      return params;
    }
    case "codever.client.snapshot":
    case "codever.trust.get":
      return paramsWithContext(input, []);
    case "codever.client.disconnect": {
      const params = mutationParams(input, ["mode"]);
      enumValue(params.mode, "mode", ["stop", "revoke"]);
      return params;
    }
    case "codever.events.subscribe": {
      const params = paramsWithContext(input, ["afterCursor", "maxReplayEvents"]);
      optionalOpaqueId(params.afterCursor, "afterCursor");
      const maxReplayEvents = optionalPositiveInteger(
        params.maxReplayEvents,
        "maxReplayEvents",
      );
      if (
        maxReplayEvents !== undefined &&
        maxReplayEvents > NATIVE_BRIDGE_LIMITS.maxReplayEvents
      ) {
        invalidParams("maxReplayEvents exceeds the native bridge limit.");
      }
      return params;
    }
    case "codever.events.activate":
    case "codever.events.ack": {
      const params = paramsWithContext(input, ["subscriptionId", "throughCursor"]);
      opaqueId(params.subscriptionId, "subscriptionId");
      opaqueId(params.throughCursor, "throughCursor");
      return params;
    }
    case "codever.events.unsubscribe": {
      const params = paramsWithContext(input, ["subscriptionId"]);
      opaqueId(params.subscriptionId, "subscriptionId");
      return params;
    }
    case "codever.command.send": {
      const params = mutationParams(input, ["payload"]);
      const payload = strictObject(params.payload, undefined, "command payload");
      requiredString(payload.operation, "payload.operation", 128);
      return params;
    }
    case "codever.command.cancel": {
      const params = mutationParams(input, ["sessionId", "targetCommandId"]);
      opaqueId(params.sessionId, "sessionId");
      optionalOpaqueId(params.targetCommandId, "targetCommandId");
      return params;
    }
    case "codever.command.recover": {
      const params = mutationParams(input, ["commandId"]);
      opaqueId(params.commandId, "commandId");
      return params;
    }
    case "codever.command.get": {
      const params = paramsWithContext(input, ["commandId"]);
      opaqueId(params.commandId, "commandId");
      return params;
    }
    case "codever.command.release": {
      const params = mutationParams(input, ["commandId"]);
      opaqueId(params.commandId, "commandId");
      return params;
    }
    case "codever.command.resolveConflict": {
      const params = mutationParams(input, ["commandId", "action"]);
      opaqueId(params.commandId, "commandId");
      enumValue(params.action, "action", ["retry", "discard"]);
      return params;
    }
    case "codever.history.page": {
      const params = paramsWithContext(input, ["sessionId", "before", "limit", "source"]);
      opaqueId(params.sessionId, "sessionId");
      optionalOpaqueId(params.before, "before");
      const limit = positiveInteger(params.limit, "limit");
      if (limit > 100) invalidParams("history limit cannot exceed 100.");
      enumValue(params.source, "source", ["local", "matrix"]);
      return params;
    }
    case "codever.attachment.upload.open": {
      const params = mutationParams(input, ["name", "mimeType", "size", "sha256"]);
      requiredString(params.name, "name", 1_024);
      requiredString(params.mimeType, "mimeType", 256);
      const size = nonnegativeInteger(params.size, "size");
      if (size > NATIVE_BRIDGE_LIMITS.maxAttachmentBytes) {
        throw new BridgeProtocolError(
          "ATTACHMENT_TOO_LARGE",
          "Attachment exceeds the native bridge limit.",
        );
      }
      sha256(params.sha256, "sha256");
      return params;
    }
    case "codever.attachment.upload.chunk": {
      const params = paramsWithContext(input, [
        "transferId",
        "index",
        "dataBase64Url",
        "chunkSha256",
      ]);
      opaqueId(params.transferId, "transferId");
      nonnegativeInteger(params.index, "index");
      const data = requiredString(
        params.dataBase64Url,
        "dataBase64Url",
        Math.ceil((NATIVE_BRIDGE_LIMITS.attachmentChunkBytes * 4) / 3) + 8,
        true,
      );
      if (!BASE64URL_PATTERN.test(data)) invalidParams("dataBase64Url is invalid.");
      sha256(params.chunkSha256, "chunkSha256");
      return params;
    }
    case "codever.attachment.upload.finish":
    case "codever.attachment.upload.abort": {
      const params = mutationParams(input, ["transferId"]);
      opaqueId(params.transferId, "transferId");
      return params;
    }
    case "codever.attachment.download.open": {
      const params = paramsWithContext(input, ["attachment"]);
      parseAttachment(params.attachment);
      return params;
    }
    case "codever.attachment.download.read": {
      const params = paramsWithContext(input, ["transferId", "index"]);
      opaqueId(params.transferId, "transferId");
      nonnegativeInteger(params.index, "index");
      return params;
    }
    case "codever.attachment.download.close": {
      const params = paramsWithContext(input, ["transferId"]);
      opaqueId(params.transferId, "transferId");
      return params;
    }
    case "codever.pairing.inspect": {
      const params = paramsWithContext(input, ["link"]);
      requiredString(params.link, "link", 16 * 1024);
      return params;
    }
    case "codever.pairing.complete": {
      const params = mutationParams(input, ["pairingId", "deviceName"]);
      opaqueId(params.pairingId, "pairingId");
      requiredString(params.deviceName, "deviceName", 256);
      return params;
    }
    case "codever.pairing.cancel": {
      const params = mutationParams(input, ["pairingId"]);
      opaqueId(params.pairingId, "pairingId");
      return params;
    }
  }
}

function mutationParams(input: unknown, extraKeys: string[]): JsonObject {
  const params = paramsWithContext(input, ["idempotencyKey", ...extraKeys]);
  requiredUuid(params.idempotencyKey, "idempotencyKey");
  return params;
}

function paramsWithContext(input: unknown, extraKeys: string[]): JsonObject {
  const params = strictObject(input, ["context", ...extraKeys], "method params");
  const context = strictObject(params.context, ["bridgeSessionId"], "context");
  opaqueId(context.bridgeSessionId, "context.bridgeSessionId");
  return params as JsonObject;
}

function parseAttachment(input: unknown): CodeverAttachment {
  const attachment = strictObject(
    input,
    ["id", "name", "mimeType", "size", "sha256", "media"],
    "attachment",
  );
  opaqueId(attachment.id, "attachment.id");
  requiredString(attachment.name, "attachment.name", 1_024);
  requiredString(attachment.mimeType, "attachment.mimeType", 256);
  const size = nonnegativeInteger(attachment.size, "attachment.size");
  if (size > NATIVE_BRIDGE_LIMITS.maxAttachmentBytes) {
    throw new BridgeProtocolError(
      "ATTACHMENT_TOO_LARGE",
      "Attachment exceeds the native bridge limit.",
    );
  }
  sha256(attachment.sha256, "attachment.sha256");
  const media = strictObject(
    attachment.media,
    ["url", "key", "iv", "sha256", "size"],
    "attachment.media",
  );
  const url = requiredString(media.url, "attachment.media.url", 2_048);
  if (!/^mxc:\/\/[^/\s]+\/[^/\s]+$/.test(url)) {
    invalidParams("attachment.media.url must be an mxc URL.");
  }
  return {
    id: opaqueId(attachment.id, "attachment.id"),
    name: requiredString(attachment.name, "attachment.name", 1_024),
    mimeType: requiredString(attachment.mimeType, "attachment.mimeType", 256),
    size,
    sha256: sha256(attachment.sha256, "attachment.sha256"),
    media: {
      url,
      key: requiredString(media.key, "attachment.media.key", 128),
      iv: requiredString(media.iv, "attachment.media.iv", 128),
      sha256: sha256(media.sha256, "attachment.media.sha256"),
      size: positiveInteger(media.size, "attachment.media.size"),
    },
  };
}

function parseClientEvent(input: unknown, label: string): ClientEvent {
  const event = strictObject(
    input,
    ["schemaVersion", "eventId", "cursor", "occurredAt", "type", "payload"],
    label,
  );
  if (event.schemaVersion !== 1) invalidParams(`${label}.schemaVersion must be 1.`);
  const type = requiredString(event.type, `${label}.type`, 128);
  if (!EVENT_TYPES.has(type)) invalidParams(`${label}.type is not negotiated.`);
  return {
    schemaVersion: 1,
    eventId: opaqueId(event.eventId, `${label}.eventId`),
    cursor: opaqueId(event.cursor, `${label}.cursor`),
    occurredAt: nonnegativeInteger(event.occurredAt, `${label}.occurredAt`),
    type: type as ClientEvent["type"],
    payload: parseJsonValue(event.payload, `${label}.payload`),
  };
}

function parseAndBoundJson(
  input: string | unknown,
  options: ParseRpcOptions,
): unknown {
  const maxBytes = options.maxBytes ?? NATIVE_BRIDGE_LIMITS.maxRpcBytes;
  let value: unknown;
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).byteLength > maxBytes) {
      invalidRequest("JSON-RPC message exceeds the native bridge size limit.");
    }
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      throw new BridgeProtocolError("PARSE_ERROR", "Invalid JSON.");
    }
  } else {
    let encoded: string;
    try {
      encoded = JSON.stringify(input);
    } catch {
      invalidRequest("JSON-RPC value is not serializable JSON.");
    }
    if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > maxBytes) {
      invalidRequest("JSON-RPC message exceeds the native bridge size limit.");
    }
    value = input;
  }
  assertJsonShape(value, 0, options.maxDepth ?? NATIVE_BRIDGE_LIMITS.maxJsonDepth);
  return value;
}

function assertJsonShape(value: unknown, depth: number, maxDepth: number): void {
  if (depth > maxDepth) invalidRequest("JSON-RPC message exceeds the depth limit.");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidRequest("JSON numbers must be finite.");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) invalidRequest("JSON array is too large.");
    value.forEach((item) => assertJsonShape(item, depth + 1, maxDepth));
    return;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length > 10_000) invalidRequest("JSON object is too large.");
    keys.forEach((key) => {
      if (key.length > 1_024) invalidRequest("JSON object key is too long.");
      assertJsonShape(value[key], depth + 1, maxDepth);
    });
    return;
  }
  invalidRequest("JSON-RPC message contains a non-JSON value.");
}

function parseJsonValue(value: unknown, label: string): JsonValue {
  assertJsonShape(value, 0, NATIVE_BRIDGE_LIMITS.maxJsonDepth);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => parseJsonValue(entry, `${label}[${index}]`));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        parseJsonValue(entry, `${label}.${key}`),
      ]),
    );
  }
  invalidParams(`${label} must be JSON.`);
}

function strictObject(
  input: unknown,
  allowedKeys: readonly string[] | undefined,
  label: string,
  errorCode: "INVALID_REQUEST" | "INVALID_PARAMS" = "INVALID_PARAMS",
): UnknownRecord {
  if (!isRecord(input)) {
    throw new BridgeProtocolError(errorCode, `${label} must be an object.`);
  }
  if (allowedKeys) {
    const allowed = new Set(allowedKeys);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw new BridgeProtocolError(
        errorCode,
        `${label} contains unknown field: ${unknown[0]}.`,
      );
    }
  }
  return input;
}

function isRecord(input: unknown): input is UnknownRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function parseRpcId(input: unknown): RpcId {
  const value = requiredString(
    input,
    "id",
    NATIVE_BRIDGE_LIMITS.maxRpcIdLength,
  );
  if (!RPC_ID_PATTERN.test(value)) invalidRequest("Invalid JSON-RPC id.");
  return value;
}

function requiredString(
  input: unknown,
  label: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (
    typeof input !== "string" ||
    (!allowEmpty && input.length === 0) ||
    input.length > maxLength
  ) {
    invalidParams(`${label} must be a valid string.`);
  }
  return input;
}

function requiredUuid(input: unknown, label: string): string {
  const value = requiredString(input, label, 64);
  if (!UUID_PATTERN.test(value)) invalidParams(`${label} must be a UUID.`);
  return value;
}

function opaqueId(input: unknown, label: string): string {
  return requiredString(input, label, 256);
}

function optionalOpaqueId(input: unknown, label: string): string | undefined {
  return input === undefined ? undefined : opaqueId(input, label);
}

function nonnegativeInteger(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    invalidParams(`${label} must be a nonnegative safe integer.`);
  }
  return input as number;
}

function positiveInteger(input: unknown, label: string): number {
  const value = nonnegativeInteger(input, label);
  if (value < 1) invalidParams(`${label} must be positive.`);
  return value;
}

function optionalNonnegativeInteger(
  input: unknown,
  label: string,
): number | undefined {
  return input === undefined ? undefined : nonnegativeInteger(input, label);
}

function optionalPositiveInteger(
  input: unknown,
  label: string,
): number | undefined {
  return input === undefined ? undefined : positiveInteger(input, label);
}

function enumValue<const T extends string>(
  input: unknown,
  label: string,
  values: readonly T[],
): T {
  if (typeof input !== "string" || !values.includes(input as T)) {
    invalidParams(`${label} has an unsupported value.`);
  }
  return input as T;
}

function optionalEnum<const T extends string>(
  input: unknown,
  label: string,
  values: readonly T[],
): T | undefined {
  return input === undefined ? undefined : enumValue(input, label, values);
}

function versionArray(input: unknown, label: string): number[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 16) {
    invalidParams(`${label} must be a non-empty version array.`);
  }
  const versions = input.map((version) => positiveInteger(version, label));
  if (new Set(versions).size !== versions.length) {
    invalidParams(`${label} cannot contain duplicate versions.`);
  }
  return versions;
}

function capabilityArray(input: unknown, label: string): CapabilityRequest[] {
  if (!Array.isArray(input) || input.length > 64) {
    invalidParams(`${label} must be an array.`);
  }
  const capabilities = input.map((entry, index) => {
    const value = strictObject(
      entry,
      ["name", "versions"],
      `${label}[${index}]`,
    );
    return {
      name: requiredString(value.name, `${label}[${index}].name`, 128),
      versions: versionArray(value.versions, `${label}[${index}].versions`),
    };
  });
  const names = capabilities.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    invalidParams(`${label} cannot contain duplicate capability names.`);
  }
  return capabilities;
}

function sha256(input: unknown, label: string): string {
  const value = requiredString(input, label, 43);
  if (!BASE64URL_SHA256_PATTERN.test(value)) {
    invalidParams(`${label} must be a base64url SHA-256 digest.`);
  }
  return value;
}

function invalidRequest(message: string): never {
  throw new BridgeProtocolError("INVALID_REQUEST", message);
}

function invalidParams(message: string): never {
  throw new BridgeProtocolError("INVALID_PARAMS", message);
}
