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
import { processMatrixEventWithDecryptionRetry } from "../app/matrixDecryptionRetry.ts";

class FakeEncryptedEvent {
  decryptionFailure = true;
  readonly listeners = new Set<
    (event: FakeEncryptedEvent, error?: Error) => void
  >();

  isDecryptionFailure(): boolean {
    return this.decryptionFailure;
  }

  on(
    _eventName: string,
    listener: (event: FakeEncryptedEvent, error?: Error) => void,
  ): void {
    this.listeners.add(listener);
  }

  off(
    _eventName: string,
    listener: (event: FakeEncryptedEvent, error?: Error) => void,
  ): void {
    this.listeners.delete(listener);
  }

  emit(error?: Error): void {
    for (const listener of [...this.listeners]) listener(this, error);
  }
}

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

test("retries a temporarily undecryptable Matrix event after its room key arrives", async () => {
  const event = new FakeEncryptedEvent();
  let attempts = 0;
  const errors: unknown[] = [];
  await processMatrixEventWithDecryptionRetry(
    event,
    "Event.decrypted",
    async () => {
      attempts += 1;
    },
    (error) => errors.push(error),
    1_000,
  );

  assert.equal(attempts, 1);
  assert.equal(event.listeners.size, 1);
  event.emit(new Error("room key is still missing"));
  assert.equal(attempts, 1);
  assert.equal(event.listeners.size, 1);

  event.decryptionFailure = false;
  event.emit();
  await Promise.resolve();

  assert.equal(attempts, 2);
  assert.equal(event.listeners.size, 0);
  assert.deepEqual(errors, []);
});

test("does not retain a decryption listener after a successful initial open", async () => {
  const event = new FakeEncryptedEvent();
  event.decryptionFailure = false;
  let attempts = 0;
  await processMatrixEventWithDecryptionRetry(
    event,
    "Event.decrypted",
    async () => {
      attempts += 1;
    },
    () => assert.fail("A successful event must not report a retry error."),
    1_000,
  );

  assert.equal(attempts, 1);
  assert.equal(event.listeners.size, 0);
});
