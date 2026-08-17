import assert from "node:assert/strict";
import test from "node:test";
import {
  GATEWAY_HEARTBEAT_STALE_MS,
  deriveGatewayLiveness,
} from "../app/gatewayLiveness.ts";

const now = 1_000_000;

test("distinguishes a live Gateway from a stale Room State while Matrix remains connected", () => {
  assert.deepEqual(
    deriveGatewayLiveness({
      matrixStatus: "connected",
      trusted: true,
      gatewayUpdatedAt: now - GATEWAY_HEARTBEAT_STALE_MS + 1,
      now,
    }),
    { state: "online", available: true },
  );
  assert.deepEqual(
    deriveGatewayLiveness({
      matrixStatus: "connected",
      trusted: true,
      gatewayUpdatedAt: now - GATEWAY_HEARTBEAT_STALE_MS,
      now,
    }),
    { state: "offline", available: false },
  );
});

test("does not call an untrusted or still-syncing device Gateway-offline", () => {
  assert.deepEqual(
    deriveGatewayLiveness({
      matrixStatus: "connected",
      trusted: false,
      gatewayUpdatedAt: undefined,
      now,
    }),
    { state: "unavailable", available: false },
  );
  assert.deepEqual(
    deriveGatewayLiveness({
      matrixStatus: "connecting",
      trusted: true,
      gatewayUpdatedAt: now,
      now,
    }),
    { state: "matrix", available: false },
  );
});
