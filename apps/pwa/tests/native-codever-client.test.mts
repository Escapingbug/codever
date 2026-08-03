import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_BRIDGE_LIMITS,
  type BridgeMethodParams,
  type CapabilityName,
  type ClientSnapshot,
  type HelloResult,
  type RequestMethod,
} from "@codever/native-bridge";
import {
  NativeBridgeClient,
  REQUIRED_NATIVE_CAPABILITIES,
} from "../app/client/native/NativeBridgeClient.ts";
import {
  acquireNativeRpcBridge,
  type NativeBridgePort,
} from "../app/client/native/NativeRpcBridge.ts";

type Request = {
  jsonrpc: "2.0";
  id: string;
  method: RequestMethod;
  params: BridgeMethodParams[RequestMethod];
};

class RuntimePort implements NativeBridgePort {
  onmessage: NativeBridgePort["onmessage"] = null;
  readonly requests: Request[] = [];

  postMessage(message: string): void {
    const request = JSON.parse(message) as Request;
    this.requests.push(request);
    queueMicrotask(() => this.#respond(request));
  }

  deliver(notification: unknown): void {
    this.onmessage?.({ data: JSON.stringify(notification) });
  }

  #respond(request: Request): void {
    const result = responseFor(request);
    this.onmessage?.({
      data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
    });
  }
}

test("replays native state, sends a durable command, and acknowledges events", async () => {
  const port = new RuntimePort();
  const bridge = await acquireNativeRpcBridge(port);
  const hello = await bridge.hello({
    webBuild: "test-build",
    requiredCapabilities: [],
    optionalCapabilities: REQUIRED_NATIVE_CAPABILITIES.map((name) => ({
      name,
      versions: [1],
    })),
  });
  const statuses: string[] = [];
  const commandResults: string[] = [];
  const savedCursors: string[] = [];
  const client = new NativeBridgeClient(
    bridge,
    hello,
    {
      onMessage() {},
      onStatus(status) {
        statuses.push(status);
      },
      onCommandResult(result) {
        commandResults.push(result.commandId);
      },
    },
    {
      load: () => "cursor-previous",
      save: (_deviceId, cursor) => savedCursors.push(cursor),
    },
  );
  await client.ready;
  assert.equal(client.runtime, "native");
  assert.equal(client.deviceId, "native-device-1");
  assert.deepEqual(statuses, ["connected"]);
  assert.deepEqual(savedCursors, ["cursor-barrier-1"]);

  const sent = await client.send({ operation: "cancel", sessionId: "s1" });
  assert.equal(sent.commandId, "command-1");
  port.deliver({
    jsonrpc: "2.0",
    method: "codever.events.deliver",
    params: {
      subscriptionId: "subscription-1",
      events: [
        {
          schemaVersion: 1,
          eventId: "event-command-1",
          cursor: "cursor-event-2",
          occurredAt: 2,
          type: "command.changed",
          payload: {
            operationId: "operation-1",
            commandId: "command-1",
            idempotencyKey: "00000000-0000-4000-8000-000000000001",
            state: "succeeded",
            submittedAt: 1,
            updatedAt: 2,
            sequence: 1,
            revision: 4,
            completion: {
              commandId: "command-1",
              sequence: 1,
              revision: 4,
              outcome: "succeeded",
            },
          },
        },
      ],
    },
  });
  assert.deepEqual(await sent.completion, {
    commandId: "command-1",
    sequence: 1,
    revision: 4,
    outcome: "succeeded",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(commandResults, ["command-1"]);
  assert.deepEqual(savedCursors, ["cursor-barrier-1", "cursor-event-2"]);
  assert.ok(port.requests.some((request) => request.method === "codever.events.ack"));

  client.dispose();
  assert.equal(port.onmessage, null);
  assert.ok(
    port.requests.some((request) => request.method === "codever.events.unsubscribe"),
  );
  const replacement = await acquireNativeRpcBridge(port);
  replacement.close();
});

function responseFor(request: Request): unknown {
  switch (request.method) {
    case "codever.bridge.hello":
      return helloResult();
    case "codever.client.start":
      return { deviceId: "native-device-1", snapshot: snapshot() };
    case "codever.events.subscribe":
      return {
        subscriptionId: "subscription-1",
        barrierCursor: "cursor-barrier-1",
        mode: "replay",
        events: [],
      };
    case "codever.events.activate":
    case "codever.events.ack":
      return {
        subscriptionId: "subscription-1",
        throughCursor:
          request.method === "codever.events.ack"
            ? "cursor-event-2"
            : "cursor-barrier-1",
      };
    case "codever.events.unsubscribe":
      return { subscriptionId: "subscription-1", unsubscribed: true };
    case "codever.command.send": {
      const params = request.params as BridgeMethodParams["codever.command.send"];
      return {
        operationId: "operation-1",
        commandId: "command-1",
        idempotencyKey: params.idempotencyKey,
        state: "accepted",
        submittedAt: 1,
        updatedAt: 1,
        sessionId: "s1",
        sequence: 1,
        revision: 4,
      };
    }
    default:
      throw new Error(`Unexpected native method in test: ${request.method}`);
  }
}

function helloResult(): HelloResult {
  const capabilities = Object.fromEntries(
    REQUIRED_NATIVE_CAPABILITIES.map((name) => [name, { version: 1 }]),
  ) as Record<CapabilityName, { version: number }>;
  return {
    protocolVersion: 1,
    bridgeSessionId: "bridge-session-native-1",
    native: {
      runtimeVersion: "0.1.0",
      runtimeBuild: "android-test",
      platform: "android",
    },
    capabilities,
    limits: NATIVE_BRIDGE_LIMITS,
  };
}

function snapshot(): ClientSnapshot {
  return {
    schemaVersion: 1,
    deviceId: "native-device-1",
    cursor: "cursor-snapshot-1",
    generatedAt: 1,
    lifecycle: { phase: "ready", since: 1 },
    foregroundService: {
      required: true,
      active: true,
      notificationVisible: true,
    },
    trust: { state: "unpaired" },
    commands: [],
  };
}
