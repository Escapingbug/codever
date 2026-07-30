import assert from "node:assert/strict";
import test from "node:test";
import {
  installPwaUpdateFlow,
  type PwaUpdateEnvironment,
} from "../app/pwaUpdate.ts";

function updateHarness(input: { controller?: unknown; visible?: boolean } = {}) {
  const listeners = {
    controllerchange: new Set<() => void>(),
    visibilitychange: new Set<() => void>(),
    online: new Set<() => void>(),
  };
  let updateCount = 0;
  let reloadCount = 0;
  let registration:
    | {
        scriptURL: string;
        options: { updateViaCache: "none" };
      }
    | undefined;
  let visible = input.visible ?? true;
  const updateRegistration = {
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
    reload: () => {
      reloadCount += 1;
    },
  };

  return {
    environment,
    listeners,
    registration: () => registration,
    updateCount: () => updateCount,
    reloadCount: () => reloadCount,
    setVisible: (next: boolean) => {
      visible = next;
    },
  };
}

async function settleRegistration(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("bypasses the browser cache and reloads once when an update takes control", async () => {
  const harness = updateHarness({ controller: {} });
  const dispose = installPwaUpdateFlow(harness.environment);
  await settleRegistration();

  assert.deepEqual(harness.registration(), {
    scriptURL: "/sw.js",
    options: { updateViaCache: "none" },
  });
  assert.equal(harness.updateCount(), 1);

  for (const listener of harness.listeners.controllerchange) listener();
  for (const listener of harness.listeners.controllerchange) listener();
  assert.equal(harness.reloadCount(), 1);

  dispose();
  assert.equal(harness.listeners.controllerchange.size, 0);
  assert.equal(harness.listeners.visibilitychange.size, 0);
  assert.equal(harness.listeners.online.size, 0);
});

test("does not reload when the first worker claims an uncontrolled page", async () => {
  const harness = updateHarness();
  installPwaUpdateFlow(harness.environment);
  await settleRegistration();

  for (const listener of harness.listeners.controllerchange) listener();
  assert.equal(harness.reloadCount(), 0);
});

test("checks again after returning online or becoming visible", async () => {
  const harness = updateHarness({ controller: {}, visible: false });
  installPwaUpdateFlow(harness.environment);
  await settleRegistration();
  assert.equal(harness.updateCount(), 0);

  for (const listener of harness.listeners.online) listener();
  assert.equal(harness.updateCount(), 0);

  harness.setVisible(true);
  for (const listener of harness.listeners.visibilitychange) listener();
  for (const listener of harness.listeners.online) listener();
  assert.equal(harness.updateCount(), 2);
});
