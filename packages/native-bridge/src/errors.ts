import type {
  BridgeErrorCode,
  BridgeUserAction,
  JsonValue,
  RpcError,
  RpcErrorData,
} from "./types.js";

export const RPC_ERROR_NUMBERS = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  NATIVE_INTERNAL: -32603,
  BRIDGE_NOT_READY: -32001,
  PROTOCOL_UNSUPPORTED: -32002,
  CAPABILITY_UNAVAILABLE: -32003,
  UNAUTHORIZED_ORIGIN: -32004,
  STALE_WEB_INSTANCE: -32005,
  INVALID_STATE: -32010,
  USER_CANCELLED: -32011,
  IDEMPOTENCY_CONFLICT: -32020,
  OPERATION_NOT_FOUND: -32021,
  OPERATION_NOT_RECOVERABLE: -32022,
  OFFLINE: -32030,
  TIMEOUT: -32031,
  RATE_LIMITED: -32032,
  TRUST_REQUIRED: -32040,
  TRUST_BLOCKED: -32041,
  PAIRING_EXPIRED: -32042,
  PAIRING_REJECTED: -32043,
  CURSOR_EXPIRED: -32050,
  HISTORY_CURSOR_INVALID: -32051,
  TRANSFER_NOT_FOUND: -32060,
  CHUNK_CONFLICT: -32061,
  ATTACHMENT_TOO_LARGE: -32062,
  HASH_MISMATCH: -32063,
} satisfies Record<BridgeErrorCode, number>);

export type BridgeProtocolErrorOptions = {
  retryable?: boolean;
  retryAfterMs?: number;
  operationId?: string;
  userAction?: BridgeUserAction;
  details?: JsonValue;
};

export class BridgeProtocolError extends Error {
  readonly errorCode: BridgeErrorCode;
  readonly rpcCode: number;
  readonly data: RpcErrorData;

  constructor(
    errorCode: BridgeErrorCode,
    message: string,
    options: BridgeProtocolErrorOptions = {},
  ) {
    super(message);
    this.name = "BridgeProtocolError";
    this.errorCode = errorCode;
    this.rpcCode = RPC_ERROR_NUMBERS[errorCode];
    this.data = {
      errorCode,
      retryable: options.retryable ?? false,
      ...(options.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: options.retryAfterMs }),
      ...(options.operationId === undefined
        ? {}
        : { operationId: options.operationId }),
      ...(options.userAction === undefined
        ? {}
        : { userAction: options.userAction }),
      ...(options.details === undefined ? {} : { details: options.details }),
    };
  }

  toRpcError(): RpcError {
    return {
      code: this.rpcCode,
      message: this.message,
      data: this.data,
    };
  }
}

export function bridgeRpcError(
  errorCode: BridgeErrorCode,
  message: string,
  options?: BridgeProtocolErrorOptions,
): RpcError {
  return new BridgeProtocolError(errorCode, message, options).toRpcError();
}
