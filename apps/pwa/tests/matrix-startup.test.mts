import assert from "node:assert/strict";
import test from "node:test";
import {
  MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_DETAIL,
  MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_MS,
  MATRIX_CRYPTO_LOADING_DETAIL,
  MATRIX_STARTUP_BACKGROUND_RECOVERY_MS,
  MATRIX_STARTUP_FOREGROUND_BUDGET_MS,
  MATRIX_SYNC_STORE_RECOVERY_DETAIL,
  MATRIX_SYNC_STORE_SAVE_DETAIL,
  matrixInitialSyncLimit,
  shouldDeferStoredMatrixStartupForPairing,
  shouldReloadInterruptedMatrixStartup,
  shouldRebuildMatrixSyncStore,
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

test("bounds a cold mobile crypto start instead of blocking for minutes", () => {
  assert.equal(MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_MS, 45_000);
  assert.match(MATRIX_CRYPTO_LOADING_DETAIL, /downloads several megabytes/u);
  assert.match(MATRIX_CRYPTO_LOADING_DETAIL, /45 seconds/u);
  assert.match(MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_DETAIL, /45 seconds/u);
});

test("reloads one interrupted startup after returning to the foreground", () => {
  assert.equal(MATRIX_STARTUP_BACKGROUND_RECOVERY_MS, 5_000);
  assert.equal(MATRIX_STARTUP_FOREGROUND_BUDGET_MS, 60_000);
  assert.equal(
    shouldReloadInterruptedMatrixStartup({
      phase: "connecting",
      startedAt: 10_000,
      hiddenAt: 20_000,
      now: 24_999,
      visible: true,
    }),
    false,
  );
  assert.equal(
    shouldReloadInterruptedMatrixStartup({
      phase: "connecting",
      startedAt: 10_000,
      hiddenAt: 20_000,
      now: 25_000,
      visible: true,
    }),
    true,
  );
  assert.equal(
    shouldReloadInterruptedMatrixStartup({
      phase: "securing",
      startedAt: 10_000,
      hiddenAt: null,
      now: 70_000,
      visible: true,
    }),
    true,
  );
  assert.equal(
    shouldReloadInterruptedMatrixStartup({
      phase: "connected",
      startedAt: 10_000,
      hiddenAt: 20_000,
      now: 90_000,
      visible: true,
    }),
    false,
  );
  assert.equal(
    shouldReloadInterruptedMatrixStartup({
      phase: "connecting",
      startedAt: 10_000,
      hiddenAt: 20_000,
      now: 90_000,
      visible: false,
    }),
    false,
  );
});

test("defers stored native startup while an invitation owns the bridge", () => {
  assert.equal(
    shouldDeferStoredMatrixStartupForPairing({
      pairingLink: null,
      deviceInvitation: "device-invitation",
      shortInvitation: null,
    }),
    true,
  );
  assert.equal(
    shouldDeferStoredMatrixStartupForPairing({
      pairingLink: "gateway-pairing",
      deviceInvitation: null,
      shortInvitation: null,
    }),
    true,
  );
  assert.equal(
    shouldDeferStoredMatrixStartupForPairing({
      pairingLink: null,
      deviceInvitation: null,
      shortInvitation: null,
    }),
    false,
  );
});

test("rebuilds a trusted browser whose local sync store was evicted", () => {
  assert.equal(shouldRebuildMatrixSyncStore(true, null), true);
  assert.equal(shouldRebuildMatrixSyncStore(true, ""), true);
  assert.equal(shouldRebuildMatrixSyncStore(true, "s123"), false);
  assert.equal(shouldRebuildMatrixSyncStore(false, null), false);
  assert.match(MATRIX_SYNC_STORE_RECOVERY_DETAIL, /Rebuilding/u);
  assert.match(MATRIX_SYNC_STORE_RECOVERY_DETAIL, /trusted device keys/u);
  assert.match(MATRIX_SYNC_STORE_SAVE_DETAIL, /Saving/u);
});

test("uses a minimal timeline while rebuilding a trusted local sync store", () => {
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
