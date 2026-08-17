import type { MatrixConnectionStatus } from "./matrix";

const configuredStaleMs = Number(
  import.meta.env?.VITE_CODEVER_GATEWAY_HEARTBEAT_STALE_MS,
);

export const GATEWAY_HEARTBEAT_STALE_MS =
  Number.isFinite(configuredStaleMs) && configuredStaleMs > 0
    ? configuredStaleMs
    : 90_000;

export type GatewayLiveness = {
  state: "online" | "offline" | "matrix" | "unavailable";
  available: boolean;
};

export function deriveGatewayLiveness(input: {
  matrixStatus: MatrixConnectionStatus;
  trusted: boolean;
  gatewayUpdatedAt?: number;
  now?: number;
}): GatewayLiveness {
  if (!input.trusted) return { state: "unavailable", available: false };
  if (input.matrixStatus !== "connected") {
    return { state: "matrix", available: false };
  }
  if (input.gatewayUpdatedAt === undefined) {
    return { state: "unavailable", available: false };
  }
  if (
    (input.now ?? Date.now()) - input.gatewayUpdatedAt >=
    GATEWAY_HEARTBEAT_STALE_MS
  ) {
    return { state: "offline", available: false };
  }
  return { state: "online", available: true };
}
