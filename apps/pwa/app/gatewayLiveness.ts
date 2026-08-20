import type { MatrixConnectionStatus } from "./matrix";

export type GatewayLiveness = {
  state: "online" | "offline" | "matrix" | "unavailable";
  available: boolean;
};

export function deriveGatewayLiveness(input: {
  matrixStatus: MatrixConnectionStatus;
  trusted: boolean;
  gatewayUpdatedAt?: number;
}): GatewayLiveness {
  if (!input.trusted) return { state: "unavailable", available: false };
  if (input.matrixStatus !== "connected") {
    return { state: "matrix", available: false };
  }
  if (input.gatewayUpdatedAt === undefined) {
    return { state: "unavailable", available: false };
  }
  // Protocol v3 is an offline-first Matrix journal. Once the trusted project
  // snapshot is available, a command can be durably appended even when the
  // Gateway process is temporarily asleep. Snapshot age is therefore not a
  // write lock and must not turn a healthy Matrix client into an unusable UI.
  return { state: "online", available: true };
}
