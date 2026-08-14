export const NATIVE_BRIDGE_PROTOCOL_VERSION = 1 as const;

export const NATIVE_BRIDGE_LIMITS = Object.freeze({
  maxRpcBytes: 512 * 1024,
  maxEventBatchBytes: 256 * 1024,
  maxEventBatchCount: 100,
  maxReplayEvents: 1_000,
  maxAttachmentBytes: 50 * 1024 * 1024,
  attachmentChunkBytes: 256 * 1024,
  maxJsonDepth: 32,
  maxRpcIdLength: 128,
});

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type RpcId = string;

export type RpcRequest<M extends string = string, P = JsonObject> = {
  jsonrpc: "2.0";
  id: RpcId;
  method: M;
  params: P;
};

export type RpcNotification<M extends string = string, P = JsonObject> = {
  jsonrpc: "2.0";
  method: M;
  params: P;
};

export type RpcSuccess<R = JsonValue> = {
  jsonrpc: "2.0";
  id: RpcId;
  result: R;
};

export type BridgeErrorCode =
  | "PARSE_ERROR"
  | "INVALID_REQUEST"
  | "METHOD_NOT_FOUND"
  | "INVALID_PARAMS"
  | "BRIDGE_NOT_READY"
  | "PROTOCOL_UNSUPPORTED"
  | "CAPABILITY_UNAVAILABLE"
  | "UNAUTHORIZED_ORIGIN"
  | "STALE_WEB_INSTANCE"
  | "INVALID_STATE"
  | "USER_CANCELLED"
  | "IDEMPOTENCY_CONFLICT"
  | "OPERATION_NOT_FOUND"
  | "OPERATION_NOT_RECOVERABLE"
  | "OFFLINE"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "TRUST_REQUIRED"
  | "TRUST_BLOCKED"
  | "PAIRING_EXPIRED"
  | "PAIRING_REJECTED"
  | "CURSOR_EXPIRED"
  | "HISTORY_CURSOR_INVALID"
  | "TRANSFER_NOT_FOUND"
  | "CHUNK_CONFLICT"
  | "ATTACHMENT_TOO_LARGE"
  | "HASH_MISMATCH"
  | "NATIVE_INTERNAL";

export type BridgeUserAction =
  | "retry"
  | "open_app"
  | "repair_trust"
  | "pair_again"
  | "update_native";

export type RpcErrorData = {
  errorCode: BridgeErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
  operationId?: string;
  userAction?: BridgeUserAction;
  details?: JsonValue;
};

export type RpcError = {
  code: number;
  message: string;
  data: RpcErrorData;
};

export type RpcFailure = {
  jsonrpc: "2.0";
  id: RpcId | null;
  error: RpcError;
};

export type RpcResponse<R = JsonValue> = RpcSuccess<R> | RpcFailure;

export type CapabilityName =
  | "client.lifecycle"
  | "events.replay"
  | "state.snapshot"
  | "commands.durable"
  | "history.page"
  | "attachments.chunked"
  | "pairing.native"
  | "trust.native"
  | "matrix.session-bootstrap"
  | "matrix.login-token"
  | "background.foreground-service";

export type CapabilityRequest = {
  name: CapabilityName | (string & {});
  versions: number[];
};

export type NegotiatedCapability = {
  version: number;
  options?: JsonObject;
};

export type HelloParams = {
  application: "codever-web";
  webBuild: string;
  webInstanceId: string;
  supportedProtocolVersions: number[];
  requiredCapabilities: CapabilityRequest[];
  optionalCapabilities: CapabilityRequest[];
};

export type HelloResult = {
  protocolVersion: number;
  bridgeSessionId: string;
  native: {
    runtimeVersion: string;
    runtimeBuild: string;
    platform: "android" | "windows" | "macos";
  };
  capabilities: Record<string, NegotiatedCapability>;
  limits: typeof NATIVE_BRIDGE_LIMITS;
};

export type BridgeContext = {
  bridgeSessionId: string;
};

export type ContextParams = {
  context: BridgeContext;
};

export type IdempotentMutationParams = ContextParams & {
  idempotencyKey: string;
};

export type LifecyclePhase =
  | "stopped"
  | "starting"
  | "unpaired"
  | "connecting"
  | "securing"
  | "ready"
  | "reconnecting"
  | "offline"
  | "blocked";

export type PublicTrustState =
  | { state: "unpaired" }
  | { state: "pairing"; pairingId: string; expiresAt: number }
  | {
      state: "trusted";
      gatewayId: string;
      gatewayName: string;
      certificateId: string;
      pairedAt: number;
      activeDeviceCount?: number;
    }
  | { state: "blocked"; reasonCode: string };

export type PublicCommandError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type CommandCompletion = {
  commandId: string;
  sequence: number;
  revision: number;
  outcome: "succeeded" | "failed" | "cancelled";
  sessionId?: string;
  result?: JsonValue;
  error?: PublicCommandError;
};

export type CommandState =
  | "queued"
  | "transmitting"
  | "accepted"
  | "running"
  | "needs_review"
  | "recovery_required"
  | "succeeded"
  | "failed"
  | "cancelled";

export type CommandView = {
  operationId: string;
  commandId?: string;
  idempotencyKey: string;
  state: CommandState;
  submittedAt: number;
  updatedAt: number;
  sessionId?: string;
  sequence?: number;
  revision?: number;
  cancelRequested?: boolean;
  completion?: CommandCompletion;
};

export type CommandReceipt = Pick<
  CommandView,
  | "operationId"
  | "commandId"
  | "idempotencyKey"
  | "state"
  | "submittedAt"
  | "updatedAt"
  | "sessionId"
  | "sequence"
  | "revision"
>;

export type ClientSnapshot = {
  schemaVersion: 1;
  deviceId: string;
  cursor: string;
  generatedAt: number;
  lifecycle: {
    phase: LifecyclePhase;
    since: number;
    detailCode?: string;
  };
  foregroundService: {
    required: true;
    active: boolean;
    notificationVisible: boolean;
  };
  trust: PublicTrustState;
  gatewayState?: JsonObject;
  commands: CommandView[];
  pairing?: JsonObject;
};

export type ClientStartResult = {
  deviceId: string;
  snapshot: ClientSnapshot;
};

export type MatrixRoomBinding = {
  roomId: string;
  gatewayId: string;
  conversationId: string;
  gatewayUserId: string;
  gatewayDeviceId: string;
  gatewayDeviceEd25519: string;
};

export type PublicMatrixSession = {
  homeserver: string;
  userId: string;
  matrixDeviceId: string;
  roomBinding: MatrixRoomBinding;
};

export type ClientBootstrapResult = {
  deviceId: string;
  session: PublicMatrixSession;
  snapshot: ClientSnapshot;
};

export type ClientDisconnectResult = {
  mode: "stop" | "revoke";
  snapshot: ClientSnapshot;
};

export type ClientEventType =
  | "client.status.changed"
  | "trust.changed"
  | "gateway.state.changed"
  | "message.upserted"
  | "message.removed"
  | "command.changed"
  | "attachment.changed"
  | "pairing.changed";

export type ClientEvent = {
  schemaVersion: 1;
  eventId: string;
  cursor: string;
  occurredAt: number;
  type: ClientEventType;
  payload: JsonValue;
};

export type EventsSubscribeParams = {
  context: BridgeContext;
  afterCursor?: string;
  maxReplayEvents?: number;
};

export type EventsSubscribeResult = {
  subscriptionId: string;
  barrierCursor: string;
} & (
  | { mode: "replay"; events: ClientEvent[] }
  | { mode: "snapshot"; snapshot: ClientSnapshot }
);

export type EventsActivateParams = {
  context: BridgeContext;
  subscriptionId: string;
  throughCursor: string;
};

export type EventsAckParams = EventsActivateParams;

export type EventsCursorResult = {
  subscriptionId: string;
  throughCursor: string;
};

export type EventsUnsubscribeResult = {
  subscriptionId: string;
  unsubscribed: true;
};

export type EventsDeliverNotification = RpcNotification<
  "codever.events.deliver",
  { subscriptionId: string; events: ClientEvent[] }
>;

export type EncryptedMedia = {
  url: string;
  key: string;
  iv: string;
  sha256: string;
  size: number;
};

export type CodeverAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  media: EncryptedMedia;
};

export type ToolCategory =
  | "read"
  | "edit"
  | "write"
  | "execute"
  | "search"
  | "agent"
  | "unknown";

export type ToolPhase = "started" | "updated" | "completed" | "failed";

export type ToolPresentationItem = {
  id: string;
  name: string;
  title: string;
  detail?: string;
  result?: string;
  category: ToolCategory;
  phase: ToolPhase;
  isError: boolean;
  startedAt: number;
  updatedAt: number;
};

export type ToolGroupPresentation = {
  kind: "tool_group";
  version: 1;
  groupId: string;
  tools: ToolPresentationItem[];
};

export type ClientMessage = {
  eventId: string;
  sender: string;
  timestamp: number;
  /** True only after the native runtime authenticated and decrypted it. */
  encrypted: boolean;
  kind: "notice" | "user" | "agent" | "tool" | "permission" | "error";
  text?: string;
  sessionId?: string;
  historical?: boolean;
  operationId?: string;
  requestId?: string;
  replacesEventId?: string;
  commandId?: string;
  revision?: number;
  originDeviceId?: string;
  originDeviceName?: string;
  activeDeviceCount?: number;
  format: "plain" | "markdown" | "html";
  attachments?: CodeverAttachment[];
  toolGroup?: ToolGroupPresentation;
  /** Normalized Codever semantic payload; never a raw Matrix event. */
  semantic?: JsonObject;
};

export type HistoryPageResult = {
  sessionId: string;
  messages: ClientMessage[];
  nextBefore?: string;
  hasMore: boolean;
  asOfCursor: string;
};

export type PairingPreview = {
  pairingId: string;
  gatewayId: string;
  gatewayName: string;
  verificationCode: string;
  expiresAt: number;
  requiresNativeConfirmation: true;
};

export type PairingCompleteResult = {
  trust: Extract<PublicTrustState, { state: "trusted" }>;
  snapshot: ClientSnapshot;
};

export type PairingCancelResult = {
  pairingId: string;
  cancelled: true;
};

export type AttachmentUploadOpenResult = {
  transferId: string;
  chunkBytes: number;
  nextIndex: number;
  expiresAt: number;
};

export type AttachmentUploadChunkResult = {
  transferId: string;
  index: number;
  receivedBytes: number;
  nextIndex: number;
};

export type AttachmentUploadFinishResult = {
  attachment: CodeverAttachment;
};

export type AttachmentUploadAbortResult = {
  transferId: string;
  aborted: true;
};

export type AttachmentDownloadOpenResult = {
  transferId: string;
  size: number;
  sha256: string;
  chunkBytes: number;
  chunkCount: number;
};

export type AttachmentDownloadReadResult = {
  transferId: string;
  index: number;
  dataBase64Url: string;
  chunkSha256: string;
  eof: boolean;
};

export type AttachmentDownloadCloseResult = {
  transferId: string;
  closed: true;
};

export type CommandReleaseResult = {
  commandId: string;
  released: true;
};

export const REQUEST_METHODS = [
  "codever.bridge.hello",
  "codever.client.start",
  "codever.client.bootstrap",
  "codever.matrix.loginToken",
  "codever.client.snapshot",
  "codever.client.disconnect",
  "codever.events.subscribe",
  "codever.events.activate",
  "codever.events.ack",
  "codever.events.unsubscribe",
  "codever.command.send",
  "codever.command.cancel",
  "codever.command.recover",
  "codever.command.get",
  "codever.command.release",
  "codever.command.resolveConflict",
  "codever.history.page",
  "codever.attachment.upload.open",
  "codever.attachment.upload.chunk",
  "codever.attachment.upload.finish",
  "codever.attachment.upload.abort",
  "codever.attachment.download.open",
  "codever.attachment.download.read",
  "codever.attachment.download.close",
  "codever.pairing.inspect",
  "codever.pairing.complete",
  "codever.pairing.cancel",
  "codever.trust.get",
] as const;

export type RequestMethod = (typeof REQUEST_METHODS)[number];

export const MUTATION_METHODS = [
  "codever.client.start",
  "codever.client.bootstrap",
  "codever.matrix.loginToken",
  "codever.client.disconnect",
  "codever.command.send",
  "codever.command.cancel",
  "codever.command.recover",
  "codever.command.release",
  "codever.command.resolveConflict",
  "codever.attachment.upload.open",
  "codever.attachment.upload.finish",
  "codever.attachment.upload.abort",
  "codever.pairing.complete",
  "codever.pairing.cancel",
] as const satisfies readonly RequestMethod[];

export type MutationMethod = (typeof MUTATION_METHODS)[number];

export type MatrixLoginTokenResult =
  | {
      status: "ready";
      /** Single-use secret. Callers must never log or persist this value. */
      loginToken: string;
      expiresAt: number;
    }
  | {
      status: "reauth-required";
      passwordSupported: boolean;
    }
  | {
      status: "unsupported";
    };

export type BridgeMethodParams = {
  "codever.bridge.hello": HelloParams;
  "codever.client.start": IdempotentMutationParams;
  "codever.client.bootstrap": IdempotentMutationParams & {
    homeserver: string;
    expectedUserId: string;
    deviceName: string;
    roomBinding: MatrixRoomBinding;
  } & (
    | {
        /** Single-use secret: never log it or persist it in an idempotency record. */
        oneTimeLoginToken: string;
        password?: never;
      }
    | {
        /** Fallback login secret: memory-only and never included in diagnostics. */
        password: string;
        oneTimeLoginToken?: never;
      }
  );
  "codever.matrix.loginToken": IdempotentMutationParams & {
    /** Successful device.invite command whose lifetime bounds this token. */
    invitationId: string;
    /** Reauthentication secret: memory-only and never included in diagnostics. */
    password?: string;
  };
  "codever.client.snapshot": ContextParams;
  "codever.client.disconnect": IdempotentMutationParams & {
    mode: "stop" | "revoke";
  };
  "codever.events.subscribe": EventsSubscribeParams;
  "codever.events.activate": EventsActivateParams;
  "codever.events.ack": EventsAckParams;
  "codever.events.unsubscribe": ContextParams & { subscriptionId: string };
  "codever.command.send": IdempotentMutationParams & {
    payload: JsonObject & { operation: string };
  };
  "codever.command.cancel": IdempotentMutationParams & {
    sessionId: string;
    targetCommandId?: string;
  };
  "codever.command.recover": IdempotentMutationParams & { commandId: string };
  "codever.command.get": ContextParams & { commandId: string };
  "codever.command.release": IdempotentMutationParams & { commandId: string };
  "codever.command.resolveConflict": IdempotentMutationParams & {
    commandId: string;
    action: "retry" | "discard";
  };
  "codever.history.page": ContextParams & {
    sessionId: string;
    before?: string;
    limit: number;
  };
  "codever.attachment.upload.open": IdempotentMutationParams & {
    name: string;
    mimeType: string;
    size: number;
    sha256: string;
  };
  "codever.attachment.upload.chunk": ContextParams & {
    transferId: string;
    index: number;
    dataBase64Url: string;
    chunkSha256: string;
  };
  "codever.attachment.upload.finish": IdempotentMutationParams & {
    transferId: string;
  };
  "codever.attachment.upload.abort": IdempotentMutationParams & {
    transferId: string;
  };
  "codever.attachment.download.open": ContextParams & {
    attachment: CodeverAttachment;
  };
  "codever.attachment.download.read": ContextParams & {
    transferId: string;
    index: number;
  };
  "codever.attachment.download.close": ContextParams & { transferId: string };
  "codever.pairing.inspect": ContextParams & { link: string };
  "codever.pairing.complete": IdempotentMutationParams & {
    pairingId: string;
    deviceName: string;
  };
  "codever.pairing.cancel": IdempotentMutationParams & { pairingId: string };
  "codever.trust.get": ContextParams;
};

export type BridgeMethodResults = {
  "codever.bridge.hello": HelloResult;
  "codever.client.start": ClientStartResult;
  "codever.client.bootstrap": ClientBootstrapResult;
  "codever.matrix.loginToken": MatrixLoginTokenResult;
  "codever.client.snapshot": ClientSnapshot;
  "codever.client.disconnect": ClientDisconnectResult;
  "codever.events.subscribe": EventsSubscribeResult;
  "codever.events.activate": EventsCursorResult;
  "codever.events.ack": EventsCursorResult;
  "codever.events.unsubscribe": EventsUnsubscribeResult;
  "codever.command.send": CommandReceipt;
  "codever.command.cancel": CommandReceipt;
  "codever.command.recover": CommandReceipt;
  "codever.command.get": CommandView;
  "codever.command.release": CommandReleaseResult;
  "codever.command.resolveConflict": CommandReceipt;
  "codever.history.page": HistoryPageResult;
  "codever.attachment.upload.open": AttachmentUploadOpenResult;
  "codever.attachment.upload.chunk": AttachmentUploadChunkResult;
  "codever.attachment.upload.finish": AttachmentUploadFinishResult;
  "codever.attachment.upload.abort": AttachmentUploadAbortResult;
  "codever.attachment.download.open": AttachmentDownloadOpenResult;
  "codever.attachment.download.read": AttachmentDownloadReadResult;
  "codever.attachment.download.close": AttachmentDownloadCloseResult;
  "codever.pairing.inspect": PairingPreview;
  "codever.pairing.complete": PairingCompleteResult;
  "codever.pairing.cancel": PairingCancelResult;
  "codever.trust.get": PublicTrustState;
};

export type BridgeRequest<M extends RequestMethod = RequestMethod> =
  M extends RequestMethod ? RpcRequest<M, BridgeMethodParams[M]> : never;

export type ParsedBridgeRequest = BridgeRequest;

export type MethodRpcResponse<M extends RequestMethod> =
  | RpcSuccess<BridgeMethodResults[M]>
  | RpcFailure;
