import assert from "node:assert/strict";
import test from "node:test";
import { deriveGatewayLiveness } from "../app/gatewayLiveness.ts";

const now = 1_000_000;

test("keeps the durable Matrix journal writable regardless of snapshot age", () => {
  assert.deepEqual(
    deriveGatewayLiveness({
      matrixStatus: "connected",
      trusted: true,
      gatewayUpdatedAt: now,
    }),
    { state: "online", available: true },
  );
  assert.deepEqual(
    deriveGatewayLiveness({
      matrixStatus: "connected",
      trusted: true,
      gatewayUpdatedAt: 0,
    }),
    { state: "online", available: true },
  );
});

test("does not call an untrusted or still-syncing device Gateway-offline", () => {
  assert.deepEqual(
    deriveGatewayLiveness({
      matrixStatus: "connected",
      trusted: false,
      gatewayUpdatedAt: undefined,
    }),
    { state: "unavailable", available: false },
  );
  assert.deepEqual(
    deriveGatewayLiveness({
      matrixStatus: "connecting",
      trusted: true,
      gatewayUpdatedAt: now,
    }),
    { state: "matrix", available: false },
  );
});
