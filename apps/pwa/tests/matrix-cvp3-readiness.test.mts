import assert from "node:assert/strict";
import test from "node:test";
import { MatrixCvp3Readiness } from "../app/matrixCvp3Readiness.ts";

test("a trusted Matrix transport stays in recovery until CVP/3 state converges", () => {
  const readiness = new MatrixCvp3Readiness(true);

  assert.equal(readiness.phase, "recovering");
  assert.equal(readiness.canPublishAuthoritativeProjection, false);
  assert.deepEqual(readiness.statusForMatrixSync("PREPARED"), {
    status: "connecting",
    detail: "matrix_gateway_state_syncing",
  });
  assert.deepEqual(readiness.statusForMatrixSync("SYNCING"), {
    status: "connecting",
    detail: "matrix_gateway_state_syncing",
  });

  readiness.completeRecovery();
  assert.equal(readiness.canPublishAuthoritativeProjection, true);
  assert.deepEqual(readiness.statusForMatrixSync("SYNCING"), {
    status: "connected",
  });
});

test("later successful Matrix sync cannot hide authoritative recovery failure", () => {
  const readiness = new MatrixCvp3Readiness(true);
  const detail = "The current CVP/3 snapshot could not be recovered.";

  readiness.failRecovery(detail);
  for (const state of ["SYNCING", "PREPARED", "RECONNECTING", "CATCHUP", "ERROR"]) {
    assert.deepEqual(readiness.statusForMatrixSync(state), {
      status: "error",
      detail,
    });
  }
  assert.equal(readiness.canPublishAuthoritativeProjection, false);

  readiness.beginRecovery();
  assert.deepEqual(readiness.statusForMatrixSync("SYNCING"), {
    status: "connecting",
    detail: "matrix_gateway_state_syncing",
  });
  readiness.completeRecovery();
  assert.deepEqual(readiness.statusForMatrixSync("SYNCING"), {
    status: "connected",
  });
});

test("an unpaired client may report transport readiness for the pairing flow", () => {
  const readiness = new MatrixCvp3Readiness(false);

  assert.equal(readiness.phase, "transport-only");
  assert.equal(readiness.canPublishAuthoritativeProjection, false);
  assert.deepEqual(readiness.statusForMatrixSync("PREPARED"), {
    status: "connected",
  });

  readiness.beginRecovery();
  assert.deepEqual(readiness.statusForMatrixSync("SYNCING"), {
    status: "connecting",
    detail: "matrix_gateway_state_syncing",
  });
});
