import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NATIVE_BRIDGE_LIMITS } from "@codever/native-bridge";
import {
  NATIVE_BRIDGE_DEFAULT_TIMEOUT_MS,
  NATIVE_COMMAND_CONFLICT_TIMEOUT_MS,
  NATIVE_HISTORY_PAGE_TIMEOUT_MS,
  NATIVE_PAIRING_COMPLETE_TIMEOUT_MS,
  NativeRpcBridge,
  acquireNativeRpcBridge,
  injectedNativeBridgePort,
  nativeBridgeRequestTimeoutMs,
  type NativeBridgePort,
} from "../app/client/native/NativeRpcBridge.ts";

class FakeNativePort implements NativeBridgePort {
  onmessage: NativeBridgePort["onmessage"] = null;
  requests: Array<Record<string, unknown>> = [];

  postMessage(message: string): void {
    this.requests.push(JSON.parse(message) as Record<string, unknown>);
  }

  respond(result: unknown): void {
    const request = this.requests.at(-1);
    assert.ok(request);
    this.onmessage?.({
      data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
    });
  }
}

test("handshakes over the origin-scoped injected native port", async () => {
  const port = new FakeNativePort();
  const bridge = new NativeRpcBridge(port);
  const ready = bridge.hello({
    webBuild: "test-build",
    requiredCapabilities: [
      { name: "background.foreground-service", versions: [1] },
    ],
  });
  assert.equal(port.requests[0]?.method, "codever.bridge.hello");
  port.respond({
    protocolVersion: 1,
    bridgeSessionId: "bridge-session-1",
    native: {
      runtimeVersion: "0.1.0",
      runtimeBuild: "android-test",
      platform: "android",
    },
    capabilities: {
      "background.foreground-service": { version: 1 },
    },
    limits: NATIVE_BRIDGE_LIMITS,
  });
  assert.equal((await ready).native.platform, "android");
  assert.deepEqual(bridge.context(), { bridgeSessionId: "bridge-session-1" });

  bridge.close();
  assert.equal(port.onmessage, null);
});

test("isolates malformed native messages without failing valid requests", async () => {
  const port = new FakeNativePort();
  const rejected: unknown[] = [];
  const bridge = new NativeRpcBridge(port, (error) => rejected.push(error));
  const response = bridge.request("codever.bridge.hello", {
    application: "codever-web",
    webBuild: "test-build",
    webInstanceId: crypto.randomUUID(),
    supportedProtocolVersions: [1],
    requiredCapabilities: [],
    optionalCapabilities: [],
  });
  port.onmessage?.({ data: "not-json" });
  port.respond({
    protocolVersion: 1,
    bridgeSessionId: "bridge-session-2",
    native: {
      runtimeVersion: "0.1.0",
      runtimeBuild: "android-test",
      platform: "android",
    },
    capabilities: {},
    limits: NATIVE_BRIDGE_LIMITS,
  });
  assert.equal((await response).bridgeSessionId, "bridge-session-2");
  assert.equal(rejected.length, 1);
  bridge.close();
});

test("rejects the correlated request when its method result is invalid", async () => {
  const port = new FakeNativePort();
  const protocolErrors: unknown[] = [];
  const bridge = new NativeRpcBridge(port, (error) => protocolErrors.push(error));
  const response = bridge.request("codever.client.snapshot", {
    context: { bridgeSessionId: "bridge-session-3" },
  });

  port.respond({ schemaVersion: 1 });

  await assert.rejects(response, /snapshot/i);
  assert.equal(protocolErrors.length, 1);
  bridge.close();
});

test("detects only the supported injected bridge surface", () => {
  const port = new FakeNativePort();
  assert.equal(injectedNativeBridgePort(port), port);
  assert.ok(injectedNativeBridgePort({ postMessage() {} }));
  assert.equal(injectedNativeBridgePort(null), null);
});

test("serializes ownership while a previous Web client is detaching", async () => {
  const port = new FakeNativePort();
  const first = await acquireNativeRpcBridge(port);
  let secondResolved = false;
  const secondPromise = acquireNativeRpcBridge(port).then((bridge) => {
    secondResolved = true;
    return bridge;
  });

  await Promise.resolve();
  assert.equal(secondResolved, false);
  assert.ok(port.onmessage);

  first.close();
  const second = await secondPromise;
  assert.equal(secondResolved, true);
  assert.ok(port.onmessage);

  second.close();
  assert.equal(port.onmessage, null);
});

test("does not poison future handoffs when an unmanaged owner is attached", async () => {
  const port = new FakeNativePort();
  const legacyOwner = new NativeRpcBridge(port);

  await assert.rejects(
    acquireNativeRpcBridge(port),
    /already attached to another Web client/i,
  );

  legacyOwner.close();
  const replacement = await acquireNativeRpcBridge(port);
  replacement.close();
});

test("allows native Matrix response time for history, pairing, and conflict recovery", () => {
  assert.equal(NATIVE_BRIDGE_DEFAULT_TIMEOUT_MS, 15_000);
  assert.equal(NATIVE_COMMAND_CONFLICT_TIMEOUT_MS, 60_000);
  assert.equal(NATIVE_HISTORY_PAGE_TIMEOUT_MS, 45_000);
  assert.equal(NATIVE_PAIRING_COMPLETE_TIMEOUT_MS, 10 * 60_000);
  assert.equal(
    nativeBridgeRequestTimeoutMs("codever.command.resolveConflict"),
    NATIVE_COMMAND_CONFLICT_TIMEOUT_MS,
  );
  assert.equal(
    nativeBridgeRequestTimeoutMs("codever.history.page"),
    NATIVE_HISTORY_PAGE_TIMEOUT_MS,
  );
  assert.equal(
    nativeBridgeRequestTimeoutMs("codever.pairing.complete"),
    NATIVE_PAIRING_COMPLETE_TIMEOUT_MS,
  );
  assert.equal(
    nativeBridgeRequestTimeoutMs("codever.client.snapshot"),
    NATIVE_BRIDGE_DEFAULT_TIMEOUT_MS,
  );
});

test("keeps native conflict decisions independent from slow Matrix command delivery", async () => {
  const runtime = await readFile(
    new URL(
      "../../../clients/android/app/src/main/java/id/my/anciety/codever/client/NativeClientRuntime.kt",
      import.meta.url,
    ),
    "utf8",
  );
  const conflictHandler = runtime.match(
    /suspend fun resolveConflict[\s\S]*?\n    fun openUpload/,
  )?.[0];
  assert.ok(conflictHandler, "Native conflict handler must remain inspectable");
  assert.doesNotMatch(conflictHandler, /mutex\.withLock/);
  assert.match(conflictHandler, /launchCommandTransmission/);

  const transmission = runtime.match(
    /private suspend fun transmit[\s\S]*?\n    private fun schedulePendingCommandRecoveries/,
  )?.[0];
  assert.ok(transmission, "Native command transmission must remain inspectable");
  assert.match(transmission, /val transmission = mutex\.withLock/);
  assert.match(
    transmission,
    /}\s*\?: return\s*\n\s*try \{\s*\n\s*sendTrustedControlMessage/,
  );
});
