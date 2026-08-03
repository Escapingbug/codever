import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_BRIDGE_LIMITS,
  type HelloResult,
} from "@codever/native-bridge";
import type { MatrixConnectionConfig } from "../app/matrix.ts";
import type {
  CodeverClient,
  CodeverClientHandlers,
} from "../app/client/CodeverClient.ts";
import {
  NATIVE_MANAGED_ACCESS_TOKEN,
  bootstrapNativeMatrixSessionIfAvailable,
  createCodeverClient,
} from "../app/client/createCodeverClient.ts";
import { REQUIRED_NATIVE_CAPABILITIES } from "../app/client/native/NativeBridgeClient.ts";
import {
  NativeRpcBridge,
  type NativeBridgePort,
} from "../app/client/native/NativeRpcBridge.ts";
import type { createWebCodeverClient } from "../app/client/web/WebCodeverClient.ts";

const config: MatrixConnectionConfig = {
  homeserver: "https://matrix.example.test",
  userId: "@device:example.test",
  accessToken: "web-token",
  matrixDeviceId: "WEB_DEVICE",
  roomId: "!room:example.test",
  gatewayId: "gateway-1",
  conversationId: "conversation-1",
  gatewayMatrixUserId: "@gateway:example.test",
  gatewayMatrixDeviceId: "GATEWAY_DEVICE",
  gatewayMatrixEd25519: "gateway-ed25519",
};

class HelloPort implements NativeBridgePort {
  onmessage: NativeBridgePort["onmessage"] = null;

  postMessage(message: string): void {
    const request = JSON.parse(message) as { id: string; method: string };
    assert.equal(request.method, "codever.bridge.hello");
    const result: HelloResult = {
      protocolVersion: 1,
      bridgeSessionId: "bridge-partial-1",
      native: {
        runtimeVersion: "0.1.0",
        runtimeBuild: "android-test",
        platform: "android",
      },
      capabilities: {
        "background.foreground-service": { version: 1 },
        "matrix.session-bootstrap": { version: 1 },
      },
      limits: NATIVE_BRIDGE_LIMITS,
    };
    queueMicrotask(() => {
      this.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      });
    });
  }
}

test("uses Web directly when no native host is injected", async () => {
  const webClient = { runtime: "web" } as CodeverClient;
  let webCreates = 0;
  const client = await createCodeverClient(
    config,
    quietHandlers(),
    {
      nativePort: () => null,
      createBridge: (port) => new NativeRpcBridge(port),
      createWeb: (async () => {
        webCreates += 1;
        return webClient;
      }) as typeof createWebCodeverClient,
    },
  );
  assert.equal(client, webClient);
  assert.equal(webCreates, 1);
});

test("falls back explicitly when the native host is only a Matrix scaffold", async () => {
  const port = new HelloPort();
  const webClient = { runtime: "web" } as CodeverClient;
  const statusDetails: string[] = [];
  const nativeBuilds: string[] = [];
  const client = await createCodeverClient(
    config,
    {
      ...quietHandlers(),
      onStatus(_status, detail) {
        if (detail) statusDetails.push(detail);
      },
      onNativeRuntime(runtime) {
        if (runtime) nativeBuilds.push(runtime.runtimeBuild);
      },
    },
    {
      nativePort: () => port,
      createBridge: (nativePort) => new NativeRpcBridge(nativePort),
      createWeb: (async () => webClient) as typeof createWebCodeverClient,
    },
  );
  assert.equal(client, webClient);
  assert.equal(port.onmessage, null);
  assert.match(statusDetails.join("\n"), /complete Codever runtime/i);
  assert.deepEqual(nativeBuilds, ["android-test"]);
});

test("keeps a browser-owned Matrix session on Web even with a complete native host", async () => {
  const port = new BootstrapPort();
  const webClient = { runtime: "web" } as CodeverClient;
  const statusDetails: string[] = [];
  const client = await createCodeverClient(
    config,
    {
      ...quietHandlers(),
      onStatus(_status, detail) {
        if (detail) statusDetails.push(detail);
      },
    },
    {
      nativePort: () => port,
      createBridge: (nativePort) => new NativeRpcBridge(nativePort),
      createWeb: (async () => webClient) as typeof createWebCodeverClient,
    },
  );
  assert.equal(client, webClient);
  assert.match(statusDetails.join("\n"), /browser-owned|device invitation/i);
});

test("fails closed when a native-owned Matrix session loses its host", async () => {
  let webCreates = 0;
  await assert.rejects(
    createCodeverClient(
      { ...config, accessToken: NATIVE_MANAGED_ACCESS_TOKEN },
      quietHandlers(),
      {
        nativePort: () => null,
        createBridge: (port) => new NativeRpcBridge(port),
        createWeb: (async () => {
          webCreates += 1;
          return { runtime: "web" } as CodeverClient;
        }) as typeof createWebCodeverClient,
      },
    ),
    /duplicate Web Matrix device/i,
  );
  assert.equal(webCreates, 0);
});

test("consumes a one-time login token only after complete native negotiation", async () => {
  const partial = new HelloPort();
  const input = nativeBootstrapInput();
  assert.equal(
    await bootstrapNativeMatrixSessionIfAvailable(input, {
      nativePort: () => partial,
      createBridge: (port) => new NativeRpcBridge(port),
    }),
    null,
  );

  const complete = new BootstrapPort();
  const result = await bootstrapNativeMatrixSessionIfAvailable(input, {
    nativePort: () => complete,
    createBridge: (port) => new NativeRpcBridge(port),
  });
  assert.equal(result?.session.matrixDeviceId, "NATIVE_MATRIX_DEVICE");
  assert.equal(complete.bootstrapToken, "single-use-secret");
});

function quietHandlers(): CodeverClientHandlers {
  return {
    onMessage() {},
    onStatus() {},
  };
}

function nativeBootstrapInput() {
  return {
    homeserver: "https://matrix.example.test",
    oneTimeLoginToken: "single-use-secret",
    expectedUserId: "@device:example.test",
    deviceName: "Android test",
    roomBinding: {
      roomId: "!room:example.test",
      gatewayId: "gateway-1",
      conversationId: "conversation-1",
      gatewayUserId: "@gateway:example.test",
      gatewayDeviceId: "GATEWAY_DEVICE",
      gatewayDeviceEd25519: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  } as const;
}

class BootstrapPort implements NativeBridgePort {
  onmessage: NativeBridgePort["onmessage"] = null;
  bootstrapToken = "";

  postMessage(message: string): void {
    const request = JSON.parse(message) as {
      id: string;
      method: string;
      params: Record<string, unknown>;
    };
    let result: unknown;
    if (request.method === "codever.bridge.hello") {
      result = {
        protocolVersion: 1,
        bridgeSessionId: "bridge-complete-1",
        native: {
          runtimeVersion: "1.0.0",
          runtimeBuild: "android-complete",
          platform: "android",
        },
        capabilities: Object.fromEntries(
          REQUIRED_NATIVE_CAPABILITIES.map((name) => [name, { version: 1 }]),
        ),
        limits: NATIVE_BRIDGE_LIMITS,
      };
    } else {
      assert.equal(request.method, "codever.client.bootstrap");
      this.bootstrapToken = String(request.params.oneTimeLoginToken);
      result = {
        deviceId: "native-device-1",
        session: {
          homeserver: "https://matrix.example.test",
          userId: "@device:example.test",
          matrixDeviceId: "NATIVE_MATRIX_DEVICE",
          roomBinding: nativeBootstrapInput().roomBinding,
        },
        snapshot: {
          schemaVersion: 1,
          deviceId: "native-device-1",
          cursor: "cursor-bootstrap-1",
          generatedAt: 1,
          lifecycle: { phase: "connecting", since: 1 },
          foregroundService: {
            required: true,
            active: true,
            notificationVisible: true,
          },
          trust: { state: "unpaired" },
          commands: [],
        },
      };
    }
    queueMicrotask(() => {
      this.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      });
    });
  }
}
