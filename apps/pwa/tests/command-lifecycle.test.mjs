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
import {
  canMigrateLegacyGatewayState,
  classifyGatewayStateEpoch,
  parseGatewayStateExtension,
} from "../app/gatewayState.ts";

test("authenticated Gateway state accepts revision zero and real capabilities", () => {
  assert.deepEqual(
    parseGatewayStateExtension({
      version: 1,
      kind: "gateway_state",
      state_version: 1,
      revision: 0,
      revision_epoch: "epoch-1",
      revision_epoch_generation: 1,
      active_device_count: 1,
      current_session_id: "session-1",
      sessions: [
        {
          id: "session-1",
          title: "Live session",
          updated_at: 1_700_000_000_000,
          provider: "codex",
          model: "gpt-5",
        },
      ],
      workspace: {
        cwd: "C:/workspace",
        provider: "codex",
        model: "gpt-5",
        permission_mode: "default",
      },
      capabilities: {
        models: [{ id: "gpt-5", name: "GPT-5" }],
        permission_modes: [{ id: "default", name: "Default" }],
        can_create_session: true,
        can_select_session: true,
      },
    }),
    {
      stateVersion: 1,
      revision: 0,
      revisionEpoch: "epoch-1",
      revisionEpochGeneration: 1,
      activeDeviceCount: 1,
      currentSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          title: "Live session",
          updatedAt: 1_700_000_000_000,
          provider: "codex",
          model: "gpt-5",
        },
      ],
      workspace: {
        cwd: "C:/workspace",
        provider: "codex",
        model: "gpt-5",
        permissionMode: "default",
      },
      capabilities: {
        models: [{ id: "gpt-5", name: "GPT-5" }],
        permissionModes: [{ id: "default", name: "Default" }],
        canCreateSession: true,
        canSelectSession: true,
      },
    },
  );
});

test("Gateway state rejects a missing or invalid state version", () => {
  const base = {
    version: 1,
    kind: "gateway_state",
    revision: 0,
    revision_epoch: "epoch-1",
    revision_epoch_generation: 1,
    active_device_count: 1,
    current_session_id: null,
    sessions: [],
    workspace: {
      cwd: "C:/workspace",
      provider: "codex",
      permission_mode: "default",
    },
    capabilities: {
      models: [],
      permission_modes: [{ id: "default", name: "Default" }],
      can_create_session: true,
      can_select_session: true,
    },
  };
  assert.throws(
    () => parseGatewayStateExtension(base),
    /state snapshot is malformed/,
  );
  assert.throws(
    () => parseGatewayStateExtension({ ...base, state_version: 0 }),
    /state snapshot is malformed/,
  );
});

test("revision epochs can advance once and can never return after certificate renewal", () => {
  assert.equal(
    classifyGatewayStateEpoch(undefined, undefined, [], "epoch-a", 1),
    "new",
  );
  assert.equal(
    classifyGatewayStateEpoch("epoch-a", 1, [], "epoch-a", 1),
    "current",
  );
  assert.equal(
    classifyGatewayStateEpoch("epoch-b", 2, ["epoch-a"], "epoch-a", 1),
    "retired",
  );
  assert.equal(
    classifyGatewayStateEpoch("epoch-b", 2, ["epoch-a"], "epoch-c", 3),
    "new",
  );
});

test("offline E3 before delayed E2 rejects the lower generation", () => {
  assert.equal(
    classifyGatewayStateEpoch("epoch-3", 3, ["epoch-1"], "epoch-2", 2),
    "stale",
  );
  assert.equal(
    classifyGatewayStateEpoch("epoch-3", 3, [], "forged-epoch", 3),
    "conflict",
  );
});

test("legacy cert-scoped state can migrate to a rotated epoch only with a newer state version", () => {
  assert.equal(
    canMigrateLegacyGatewayState("epoch-1", 7, "epoch-1", 7),
    true,
  );
  assert.equal(
    canMigrateLegacyGatewayState("epoch-1", 7, "epoch-2", 8),
    true,
  );
  assert.equal(
    canMigrateLegacyGatewayState("epoch-1", 7, "epoch-2", 7),
    false,
  );
  assert.equal(
    canMigrateLegacyGatewayState("epoch-1", 7, "epoch-2", 6),
    false,
  );
});

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
