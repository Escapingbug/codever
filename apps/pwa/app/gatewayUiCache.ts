import type { MatrixConnectionConfig } from "./matrix";
import {
  gatewayStateExtension,
  parseGatewayStateExtension,
  type GatewayStateSnapshot,
} from "./gatewayState";

export const GATEWAY_UI_CACHE_STORAGE_KEY = "codever.ui.gateway-state.v1";

type GatewayUiCacheRecord = {
  kind: "gateway_ui_projection";
  version: 1;
  gateway_id: string;
  conversation_id: string;
  room_id: string;
  snapshot: Record<string, unknown>;
};

/**
 * Keeps the last authenticated projection visible while the transport host is
 * reattaching. It is display-only: command availability continues to depend on
 * the live connection state and the next native/Matrix snapshot replaces it.
 */
export function readGatewayUiCache(
  storage: Pick<Storage, "getItem"> | null,
  config: MatrixConnectionConfig | null,
): GatewayStateSnapshot | null {
  if (!storage || !hasProjectionScope(config)) return null;
  try {
    const record = JSON.parse(
      storage.getItem(GATEWAY_UI_CACHE_STORAGE_KEY) ?? "null",
    ) as Partial<GatewayUiCacheRecord> | null;
    if (
      !record ||
      record.kind !== "gateway_ui_projection" ||
      record.version !== 1 ||
      record.gateway_id !== config.gatewayId ||
      record.conversation_id !== config.conversationId ||
      record.room_id !== config.roomId
    ) {
      return null;
    }
    return parseGatewayStateExtension(record.snapshot);
  } catch {
    return null;
  }
}

export function writeGatewayUiCache(
  storage: Pick<Storage, "setItem" | "removeItem"> | null,
  config: MatrixConnectionConfig,
  state: GatewayStateSnapshot,
): void {
  if (!storage || !hasProjectionScope(config)) return;
  const record: GatewayUiCacheRecord = {
    kind: "gateway_ui_projection",
    version: 1,
    gateway_id: config.gatewayId,
    conversation_id: config.conversationId,
    room_id: config.roomId,
    snapshot: gatewayStateExtension(state),
  };
  try {
    const encoded = JSON.stringify(record);
    if (encoded.length > MAX_GATEWAY_UI_CACHE_BYTES) {
      storage.removeItem(GATEWAY_UI_CACHE_STORAGE_KEY);
      return;
    }
    storage.setItem(GATEWAY_UI_CACHE_STORAGE_KEY, encoded);
  } catch {
    // A rebuildable projection must never block the live connection.
  }
}

export function clearGatewayUiCache(
  storage: Pick<Storage, "removeItem"> | null,
): void {
  try {
    storage?.removeItem(GATEWAY_UI_CACHE_STORAGE_KEY);
  } catch {
    // Clearing a display-only cache is best effort.
  }
}

function hasProjectionScope(
  config: MatrixConnectionConfig | null,
): config is MatrixConnectionConfig {
  return Boolean(
    config?.gatewayId.trim() &&
      config.conversationId.trim() &&
      config.roomId.trim(),
  );
}

const MAX_GATEWAY_UI_CACHE_BYTES = 2 * 1024 * 1024;
