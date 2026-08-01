import assert from "node:assert/strict";
import test from "node:test";
import {
  CommandAcknowledgementTimeoutError,
  CommandCompletionExpiredError,
  CommandLifecycle,
  waitForCommandCompletion,
} from "../app/commandLifecycle.ts";
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
  createGatewayStateCacheRecord,
  gatewayProjectKey,
  parseGatewayStateCacheRecord,
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
          project_id: "project-workspace",
          project_name: "workspace",
          cwd: "C:/workspace",
          provider: "codex",
          model: "gpt-5",
          reasoning_effort: "high",
        },
        {
          id: "session-archived",
          title: "Archived session",
          updated_at: 1_699_000_000_000,
          status: "idle",
          archived: true,
          project_id: "project-workspace",
          project_name: "workspace",
          cwd: "C:/workspace",
          provider: "codex",
        },
      ],
      workspace: {
        project_id: "project-workspace",
        project_name: "workspace",
        cwd: "C:/workspace",
        provider: "codex",
        model: "gpt-5",
        reasoning_effort: "high",
        permission_mode: "default",
      },
      capabilities: {
        models: [{
          id: "gpt-5",
          name: "GPT-5",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "medium", description: "Balanced" },
            { effort: "high" },
          ],
        }],
        permission_modes: [{ id: "default", name: "Default" }],
        can_create_session: true,
        can_select_session: true,
        can_archive_session: true,
        can_delete_session: true,
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
          status: "idle",
          projectId: "project-workspace",
          projectName: "workspace",
          cwd: "C:/workspace",
          provider: "codex",
          model: "gpt-5",
          reasoningEffort: "high",
        },
        {
          id: "session-archived",
          title: "Archived session",
          updatedAt: 1_699_000_000_000,
          status: "archived",
          projectId: "project-workspace",
          projectName: "workspace",
          cwd: "C:/workspace",
          provider: "codex",
        },
      ],
      workspace: {
        projectId: "project-workspace",
        projectName: "workspace",
        cwd: "C:/workspace",
        provider: "codex",
        model: "gpt-5",
        reasoningEffort: "high",
        permissionMode: "default",
      },
      capabilities: {
        models: [{
          id: "gpt-5",
          name: "GPT-5",
          defaultReasoningLevel: "medium",
          supportedReasoningLevels: [
            { effort: "medium", description: "Balanced" },
            { effort: "high" },
          ],
        }],
        permissionModes: [{ id: "default", name: "Default" }],
        canCreateSession: true,
        canSelectSession: true,
        canArchiveSession: true,
        canDeleteSession: true,
      },
    },
  );
});

test("project identity is scoped by Gateway, not by display name", () => {
  assert.notEqual(
    gatewayProjectKey("gateway-a", "project-same-name"),
    gatewayProjectKey("gateway-b", "project-same-name"),
  );
  assert.equal(
    gatewayProjectKey("gateway-a", "project-1"),
    gatewayProjectKey("gateway-a", "project-1"),
  );
});

test("cached Gateway state survives reload only for the same trust and durable epoch", () => {
  const state = parseGatewayStateExtension({
    version: 1,
    kind: "gateway_state",
    state_version: 9,
    revision: 4,
    revision_epoch: "epoch-cache",
    revision_epoch_generation: 3,
    active_device_count: 1,
    current_session_id: "session-cache",
    sessions: [
      {
        id: "session-cache",
        title: "Cached session",
        updated_at: 1_700_000_000_000,
        status: "running",
        project_id: "project-cache",
        project_name: "workspace",
        cwd: "/workspace",
        provider: "codex",
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
      },
    ],
    workspace: {
      project_id: "project-cache",
      project_name: "workspace",
      cwd: "/workspace",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      permission_mode: "default",
    },
    capabilities: {
      models: [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6",
          default_reasoning_level: "low",
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "high" },
          ],
        },
      ],
      permission_modes: [{ id: "default", name: "Default" }],
      can_create_session: true,
      can_select_session: true,
    },
  });
  assert.ok(state);
  assert.equal(state.sessions[0].status, "running");
  const binding = {
    gatewayId: "gateway-1",
    conversationId: "conversation-1",
    identityKeyId: "device-key-1",
    certificateId: "certificate-1",
  };
  const epoch = {
    revisionEpoch: state.revisionEpoch,
    revisionEpochGeneration: state.revisionEpochGeneration,
    stateVersion: state.stateVersion,
    revision: state.revision,
  };
  const record = createGatewayStateCacheRecord(binding, state);

  assert.deepEqual(
    parseGatewayStateCacheRecord(record, binding, epoch),
    state,
  );
  assert.equal(
    parseGatewayStateCacheRecord(
      record,
      { ...binding, certificateId: "certificate-2" },
      epoch,
    ),
    null,
  );
  assert.equal(
    parseGatewayStateCacheRecord(
      record,
      binding,
      { ...epoch, stateVersion: epoch.stateVersion + 1 },
    ),
    null,
  );
  const tampered = structuredClone(record);
  tampered.snapshot.revision = state.revision + 1;
  assert.equal(
    parseGatewayStateCacheRecord(tampered, binding, epoch),
    null,
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
    sessionId: "app-session-created",
    result: {
      pairingLink: "codever://pair?data=offer",
      expiresAt: 1_800_000_000_000,
    },
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

test("an acknowledgement timeout keeps the terminal result observable", async () => {
  const lifecycle = new CommandLifecycle();
  const acknowledgement = lifecycle.waitForAcknowledgement(
    "late-invitation",
    8,
    5,
  );
  const error = await acknowledgement.catch((candidate) => candidate);
  assert.ok(error instanceof CommandAcknowledgementTimeoutError);
  assert.equal(error.commandId, "late-invitation");
  assert.equal(error.sequence, 8);

  const lateCompletion = lifecycle.waitForCompletion("late-invitation", 100);
  lifecycle.recordResult({
    commandId: "late-invitation",
    sequence: 8,
    revision: 14,
    outcome: "succeeded",
    result: { pairingLink: "codever://pair?data=late" },
  });
  assert.equal((await lateCompletion).revision, 14);
  lifecycle.release("late-invitation");
});

test("bounded command observation removes its waiter at expiry", async () => {
  const lifecycle = new CommandLifecycle();
  await assert.rejects(
    lifecycle.waitForCompletion("never-finishes", 5),
    CommandCompletionExpiredError,
  );

  // A later result remains recordable and can be observed independently.
  lifecycle.recordResult({
    commandId: "never-finishes",
    sequence: 2,
    revision: 3,
    outcome: "failed",
  });
  assert.equal(
    (await lifecycle.waitForCompletion("never-finishes")).outcome,
    "failed",
  );
  lifecycle.release("never-finishes");
});

test("a missing terminal result cannot leave command UI busy forever", async () => {
  const neverCompletes = new Promise(() => {});
  await assert.rejects(
    waitForCommandCompletion(neverCompletes, 10),
    /accepted this command but did not confirm its final result/i,
  );
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
