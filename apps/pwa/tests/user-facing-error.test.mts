import assert from "node:assert/strict";
import test from "node:test";
import {
  GENERIC_ERROR_DETAIL,
  formatUserFacingError,
} from "../app/userFacingError.ts";

test("turns native RPC and network failures into calm product copy", () => {
  assert.equal(
    formatUserFacingError(
      new Error(
        "The native bridge did not answer codever.history.page in time.",
      ),
    ),
    "The connected device did not respond in time.",
  );
  assert.equal(
    formatUserFacingError(new TypeError("Failed to fetch")),
    "The network request did not complete.",
  );
  assert.equal(
    formatUserFacingError(new Error("Request timeout after 30000ms")),
    "The operation took too long.",
  );
  assert.equal(
    formatUserFacingError(new Error("HTTP 429: Too Many Requests")),
    "Too many requests. Wait a moment and try again.",
  );
});

test("hides machine details while preserving short actionable copy", () => {
  assert.equal(
    formatUserFacingError(new Error("matrix_runtime_failed")),
    GENERIC_ERROR_DETAIL,
  );
  assert.equal(
    formatUserFacingError(new Error("Connect to https://internal.invalid")),
    GENERIC_ERROR_DETAIL,
  );
  assert.equal(
    formatUserFacingError(new TypeError("Cannot read properties of undefined")),
    GENERIC_ERROR_DETAIL,
  );
  assert.equal(
    formatUserFacingError(new Error("Choose a project before continuing.")),
    "Choose a project before continuing.",
  );
  assert.equal(formatUserFacingError({ reason: "secret" }), GENERIC_ERROR_DETAIL);
});

test("normalizes and bounds user-facing details", () => {
  assert.equal(
    formatUserFacingError("  The session\n could not be opened.  "),
    "The session could not be opened.",
  );
  assert.equal(formatUserFacingError("x".repeat(300)).length, 180);
});
