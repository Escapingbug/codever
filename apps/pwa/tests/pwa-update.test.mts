import assert from "node:assert/strict";
import test from "node:test";
import {
  installPwaUpdateFlow,
  type PwaUpdateEnvironment,
  type PwaUpdateState,
} from "../app/pwaUpdate.ts";

function updateHarness(
  input: {
    controller?: unknown;
    visible?: boolean;
    latestBuild?: string;
    marker?: string | null;
    updateCheckFails?: boolean;
    reloadAllowed?: boolean;
  } = {},
) {
  const listeners = {
    controllerchange: new Set<() => void>(),
    visibilitychange: new Set<() => void>(),
    online: new Set<() => void>(),
  };
  const states: PwaUpdateState[] = [];
  const workerMessages: unknown[] = [];
  let updateCount = 0;
  let fetchCount = 0;
  let registration:
    | {
        scriptURL: string;
        options: { updateViaCache: "none" };
      }
    | undefined;
  let visible = input.visible ?? true;
  let marker = input.marker ?? null;
  let periodicListener: (() => void) | null = null;
  let periodicInterval = 0;
  let periodicStopped = false;
  let clearedQuery = false;
  let reloadTarget: string | null = null;
  let reloadAllowed = input.reloadAllowed ?? true;
  const updateRegistration = {
    waiting: {
      postMessage(message: unknown) {
        workerMessages.push(message);
      },
    },
    async update() {
      updateCount += 1;
    },
  };
  const environment: PwaUpdateEnvironment = {
    serviceWorker: {
      controller: input.controller,
      async register(scriptURL, options) {
        registration = { scriptURL, options };
        return updateRegistration;
      },
      addEventListener(_type, listener) {
        listeners.controllerchange.add(listener);
      },
      removeEventListener(_type, listener) {
        listeners.controllerchange.delete(listener);
      },
    },
    visibilityState: () => (visible ? "visible" : "hidden"),
    addVisibilityListener: (listener) =>
      listeners.visibilitychange.add(listener),
    removeVisibilityListener: (listener) =>
      listeners.visibilitychange.delete(listener),
    addOnlineListener: (listener) => listeners.online.add(listener),
    removeOnlineListener: (listener) => listeners.online.delete(listener),
    async fetchLatestBuild() {
      fetchCount += 1;
      if (input.updateCheckFails) throw new Error("offline");
      return input.latestBuild ?? "build-current";
    },
    readUpdateMarker: () => marker,
    writeUpdateMarker: (version) => {
      marker = version;
    },
    clearUpdateMarker: () => {
      marker = null;
    },
    clearUpdateQuery: () => {
      clearedQuery = true;
    },
    canReload: () => reloadAllowed,
    reloadToBuild: (version) => {
      reloadTarget = version;
    },
    startPeriodicCheck: (listener, intervalMs) => {
      periodicListener = listener;
      periodicInterval = intervalMs;
      return 17;
    },
    stopPeriodicCheck: (timer) => {
      assert.equal(timer, 17);
      periodicStopped = true;
    },
    now: () => 1_785_000_000_000,
  };

  return {
    environment,
    listeners,
    states,
    workerMessages,
    registration: () => registration,
    updateCount: () => updateCount,
    fetchCount: () => fetchCount,
    reloadTarget: () => reloadTarget,
    marker: () => marker,
    periodicInterval: () => periodicInterval,
    periodicStopped: () => periodicStopped,
    clearedQuery: () => clearedQuery,
    setVisible: (next: boolean) => {
      visible = next;
    },
    setReloadAllowed: (next: boolean) => {
      reloadAllowed = next;
    },
    runPeriodicCheck: () => periodicListener?.(),
  };
}

async function settleRegistration(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("checks a no-cache deployment version and registers a versioned worker", async () => {
  const harness = updateHarness({ controller: {} });
  const handle = installPwaUpdateFlow(
    harness.environment,
    "build-current",
    (state) => harness.states.push(state),
  );
  await settleRegistration();

  assert.deepEqual(harness.registration(), {
    scriptURL: "/sw.js?v=build-current",
    options: { updateViaCache: "none" },
  });
  assert.equal(harness.updateCount(), 1);
  assert.equal(harness.fetchCount(), 1);
  assert.equal(harness.reloadTarget(), null);
  assert.equal(harness.periodicInterval(), 5 * 60_000);
  assert.equal(harness.clearedQuery(), true);
  assert.deepEqual(harness.states.at(-1), {
    phase: "current",
    currentVersion: "build-current",
    checkedAt: 1_785_000_000_000,
  });

  handle.dispose();
  assert.equal(harness.listeners.controllerchange.size, 0);
  assert.equal(harness.listeners.visibilitychange.size, 0);
  assert.equal(harness.listeners.online.size, 0);
  assert.equal(harness.periodicStopped(), true);
});

test("forces a versioned network navigation when deployment is newer", async () => {
  const harness = updateHarness({
    controller: {},
    latestBuild: "build-next",
  });
  installPwaUpdateFlow(
    harness.environment,
    "build-current",
    (state) => harness.states.push(state),
  );
  await settleRegistration();

  assert.equal(harness.reloadTarget(), "build-next");
  assert.equal(harness.marker(), "build-current");
  assert.deepEqual(harness.states.at(-1), {
    phase: "updating",
    currentVersion: "build-current",
    latestVersion: "build-next",
  });
  assert.deepEqual(harness.workerMessages.at(-1), { type: "SKIP_WAITING" });
});

test("defers a newer deployment until an in-flight command is safe", async () => {
  const harness = updateHarness({
    controller: {},
    latestBuild: "build-next",
    reloadAllowed: false,
  });
  const handle = installPwaUpdateFlow(
    harness.environment,
    "build-current",
    (state) => harness.states.push(state),
  );
  await settleRegistration();

  assert.equal(harness.reloadTarget(), null);
  assert.equal(harness.marker(), null);
  assert.deepEqual(harness.states.at(-1), {
    phase: "waiting",
    currentVersion: "build-current",
    latestVersion: "build-next",
  });

  harness.setReloadAllowed(true);
  handle.resumeDeferredUpdate();

  assert.equal(harness.reloadTarget(), "build-next");
  assert.equal(harness.marker(), "build-current");
});

test("a worker takeover also waits for an in-flight command", async () => {
  const harness = updateHarness({
    controller: {},
    visible: false,
    reloadAllowed: false,
  });
  const handle = installPwaUpdateFlow(
    harness.environment,
    "build-current",
    (state) => harness.states.push(state),
  );
  await settleRegistration();

  for (const listener of harness.listeners.controllerchange) listener();
  assert.equal(harness.reloadTarget(), null);
  assert.deepEqual(harness.states.at(-1), {
    phase: "waiting",
    currentVersion: "build-current",
    latestVersion: "build-current",
  });

  harness.setReloadAllowed(true);
  handle.resumeDeferredUpdate();
  assert.equal(harness.reloadTarget(), "build-current");
});

test("reports the completed update after the new build reloads", async () => {
  const harness = updateHarness({ marker: "build-old", visible: false });
  const handle = installPwaUpdateFlow(
    harness.environment,
    "build-current",
    (state) => harness.states.push(state),
  );

  assert.deepEqual(harness.states[0], {
    phase: "updated",
    currentVersion: "build-current",
    previousVersion: "build-old",
  });
  assert.equal(harness.marker(), null);

  handle.dismissUpdatedNotice();
  assert.deepEqual(harness.states.at(-1), {
    phase: "current",
    currentVersion: "build-current",
  });
});

test("a worker takeover reloads an already controlled legacy page once", async () => {
  const harness = updateHarness({ controller: {}, visible: false });
  installPwaUpdateFlow(harness.environment, "build-current");
  await settleRegistration();

  for (const listener of harness.listeners.controllerchange) listener();
  for (const listener of harness.listeners.controllerchange) listener();
  assert.equal(harness.reloadTarget(), "build-current");
  assert.equal(harness.marker(), "build-current");
});

test("does not reload when the first worker claims an uncontrolled page", async () => {
  const harness = updateHarness({ visible: false });
  installPwaUpdateFlow(harness.environment, "build-current");
  await settleRegistration();

  for (const listener of harness.listeners.controllerchange) listener();
  assert.equal(harness.reloadTarget(), null);
});

test("checks again after returning online, becoming visible, or on the interval", async () => {
  const harness = updateHarness({ visible: false });
  installPwaUpdateFlow(harness.environment, "build-current");
  await settleRegistration();
  assert.equal(harness.fetchCount(), 0);

  for (const listener of harness.listeners.online) listener();
  assert.equal(harness.fetchCount(), 0);

  harness.setVisible(true);
  for (const listener of harness.listeners.visibilitychange) listener();
  await settleRegistration();
  harness.runPeriodicCheck();
  await settleRegistration();
  assert.equal(harness.fetchCount(), 2);
});

test("manual checks expose an unavailable state without reloading", async () => {
  const harness = updateHarness({ updateCheckFails: true });
  const handle = installPwaUpdateFlow(
    harness.environment,
    "build-current",
    (state) => harness.states.push(state),
  );
  await settleRegistration();

  await handle.checkNow();
  assert.deepEqual(harness.states.at(-1), {
    phase: "unavailable",
    currentVersion: "build-current",
  });
  assert.equal(harness.reloadTarget(), null);
});
