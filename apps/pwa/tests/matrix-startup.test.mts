import assert from "node:assert/strict";
import test from "node:test";
import {
  MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_DETAIL,
  MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_MS,
  MATRIX_CRYPTO_LOADING_DETAIL,
  MATRIX_SYNC_CHECKPOINT_RECOVERY_DETAIL,
  MATRIX_SYNC_CHECKPOINT_SAVE_DETAIL,
  matrixInitialSyncLimit,
  shouldRecoverMatrixSyncCheckpoint,
} from "../app/matrixStartup.ts";

test("allows a cold mobile connection enough time to load Matrix crypto", () => {
  assert.equal(MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_MS, 120_000);
  assert.match(MATRIX_CRYPTO_LOADING_DETAIL, /downloads several megabytes/u);
  assert.match(MATRIX_CRYPTO_LOADING_DETAIL, /two minutes/u);
  assert.match(MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_DETAIL, /two minutes/u);
});

test("recovers a trusted browser whose sync checkpoint was evicted", () => {
  assert.equal(shouldRecoverMatrixSyncCheckpoint(true, null), true);
  assert.equal(shouldRecoverMatrixSyncCheckpoint(true, ""), true);
  assert.equal(shouldRecoverMatrixSyncCheckpoint(true, "s123"), false);
  assert.equal(shouldRecoverMatrixSyncCheckpoint(false, null), false);
  assert.match(MATRIX_SYNC_CHECKPOINT_RECOVERY_DETAIL, /Rebuilding/u);
  assert.match(MATRIX_SYNC_CHECKPOINT_RECOVERY_DETAIL, /trusted device keys/u);
  assert.match(MATRIX_SYNC_CHECKPOINT_SAVE_DETAIL, /Saving/u);
});

test("uses a minimal timeline while rebuilding a trusted sync checkpoint", () => {
  assert.equal(matrixInitialSyncLimit(true, true), 1);
  assert.equal(matrixInitialSyncLimit(true, false), 30);
  assert.equal(matrixInitialSyncLimit(false, false), 1);
});
