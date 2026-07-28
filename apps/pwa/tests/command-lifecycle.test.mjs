import assert from "node:assert/strict";
import test from "node:test";
import { CommandLifecycle } from "../app/commandLifecycle.ts";
import {
  acquireMatrixCryptoLock,
  checkpointAndReleaseMatrixSyncStore,
  matrixCryptoLockName,
  matrixSyncDatabaseName,
  waitForMatrixSyncStoreClose,
} from "../app/matrixSyncStore.ts";

test("command result before explicit ack resolves acknowledgement and completion once", async () => {
  const lifecycle = new CommandLifecycle();
  const result = {
    commandId: "command-result-first",
    sequence: 4,
    revision: 9,
    outcome: "succeeded",
  };

  lifecycle.recordResult(result);

  assert.equal(
    await lifecycle.waitForAcknowledgement(result.commandId, result.sequence),
    result.revision,
  );
  assert.deepEqual(await lifecycle.waitForCompletion(result.commandId), result);

  // A delayed explicit ack is idempotent and cannot regress the result.
  lifecycle.recordAcknowledgement(result.commandId, result.sequence, 8);
  assert.equal(
    await lifecycle.waitForAcknowledgement(result.commandId, result.sequence),
    result.revision,
  );
  assert.deepEqual(await lifecycle.waitForCompletion(result.commandId), result);
});

test("command result permanently replaces a missing explicit ack", async () => {
  const lifecycle = new CommandLifecycle();
  const acknowledgement = lifecycle.waitForAcknowledgement(
    "command-no-ack",
    7,
    1_000,
  );
  const completion = lifecycle.waitForCompletion("command-no-ack");

  lifecycle.recordResult({
    commandId: "command-no-ack",
    sequence: 7,
    revision: 12,
    outcome: "failed",
  });

  assert.equal(await acknowledgement, 12);
  assert.deepEqual(await completion, {
    commandId: "command-no-ack",
    sequence: 7,
    revision: 12,
    outcome: "failed",
  });
});

test("Matrix sync databases are isolated by origin, user, device, and room", async () => {
  const base = {
    homeserver: "https://matrix.example/",
    userId: "@alice:example",
    matrixDeviceId: "PWA-A",
    roomId: "!room-a:example",
  };
  const names = await Promise.all([
    matrixSyncDatabaseName(base),
    matrixSyncDatabaseName({ ...base, homeserver: "https://other.example" }),
    matrixSyncDatabaseName({ ...base, userId: "@bob:example" }),
    matrixSyncDatabaseName({ ...base, matrixDeviceId: "PWA-B" }),
    matrixSyncDatabaseName({ ...base, roomId: "!room-b:example" }),
  ]);
  assert.equal(new Set(names).size, names.length);
  assert.match(names[0], /^codever-matrix-sync-v1-[A-Za-z0-9_-]{43}$/);
});

test("Matrix crypto lock is isolated by origin, user, and device", async () => {
  const base = {
    homeserver: "https://matrix.example/",
    userId: "@alice:example",
    matrixDeviceId: "PWA-A",
  };
  const names = await Promise.all([
    matrixCryptoLockName(base),
    matrixCryptoLockName({ ...base, homeserver: "https://other.example" }),
    matrixCryptoLockName({ ...base, userId: "@bob:example" }),
    matrixCryptoLockName({ ...base, matrixDeviceId: "PWA-B" }),
  ]);
  assert.equal(new Set(names).size, names.length);
});

test("Matrix crypto lock is held until explicit release", async () => {
  let callbackFinished = false;
  const lock = await acquireMatrixCryptoLock("crypto-lifetime", {
    async request(_name, options, callback) {
      assert.deepEqual(options, { mode: "exclusive", ifAvailable: true });
      await callback({ name: "crypto-lifetime" });
      callbackFinished = true;
    },
  });
  await Promise.resolve();
  assert.equal(callbackFinished, false);
  await lock.release();
  assert.equal(callbackFinished, true);
});

test("Matrix crypto access fails closed without an available Web Lock", async () => {
  await assert.rejects(
    acquireMatrixCryptoLock("crypto-unsupported", null),
    /Web Locks are unavailable/,
  );
  await assert.rejects(
    acquireMatrixCryptoLock("crypto-busy", {
      async request(_name, _options, callback) {
        await callback(null);
      },
    }),
    /Another Codever tab/,
  );
});

test("reconnect waits for the previous forced sync-state checkpoint", async () => {
  const calls = [];
  let releaseSave;
  let releaseLock;
  const saveGate = new Promise((resolve) => {
    releaseSave = resolve;
  });
  const lockGate = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const closing = checkpointAndReleaseMatrixSyncStore(
    "sync-close-behavior",
    {
      async save(force) {
        calls.push(["save", force]);
        await saveGate;
      },
      async destroy() {
        calls.push(["destroy"]);
      },
    },
    {
      async release() {
        calls.push(["release"]);
        await lockGate;
      },
    },
  );
  let reconnectReady = false;
  const reconnect = waitForMatrixSyncStoreClose(
    "sync-close-behavior",
  ).then(() => {
    reconnectReady = true;
  });

  await Promise.resolve();
  assert.equal(reconnectReady, false);
  releaseSave();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reconnectReady, false);
  releaseLock();
  await Promise.all([closing, reconnect]);
  assert.deepEqual(calls, [["save", true], ["release"]]);
  assert.equal(reconnectReady, true);
});
