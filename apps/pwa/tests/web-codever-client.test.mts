import assert from "node:assert/strict";
import test from "node:test";
import type { CommandPayload } from "@codever/protocol";
import type {
  MatrixConnection,
  MatrixConnectionConfig,
} from "../app/matrix.ts";
import {
  WebCodeverClient,
  createWebCodeverClient,
} from "../app/client/web/WebCodeverClient.ts";

const config: MatrixConnectionConfig = {
  homeserver: "https://matrix.example.test",
  userId: "@device:example.test",
  accessToken: "token",
  matrixDeviceId: "MATRIX_DEVICE",
  roomId: "!room:example.test",
  gatewayId: "gateway-1",
  conversationId: "conversation-1",
  gatewayMatrixUserId: "@gateway:example.test",
  gatewayMatrixDeviceId: "GATEWAY_DEVICE",
  gatewayMatrixEd25519: "gateway-ed25519",
};

function fakeTransport(
  onStop: () => void,
  onSend: (payload: CommandPayload) => void = () => {},
): MatrixConnection {
  const completion = {
    commandId: "command-1",
    sequence: 1,
    revision: 2,
    outcome: "succeeded" as const,
  };
  const sent = {
    eventId: "$event",
    commandId: completion.commandId,
    sequence: completion.sequence,
    revision: completion.revision,
    completion: Promise.resolve(completion),
  };
  return {
    ready: Promise.resolve(),
    identity: { keyId: "p256-device" },
    matrixDeviceKeys: {
      ed25519: "matrix-ed25519",
      curve25519: "matrix-curve25519",
    },
    deviceTransport: {
      homeserver: config.homeserver,
      roomId: config.roomId,
      userId: config.userId,
      deviceId: config.matrixDeviceId,
      ed25519: "matrix-ed25519",
    },
    async pair() {
      throw new Error("pair was not expected in this test");
    },
    async send(payload) {
      onSend(payload);
      return sent;
    },
    async recoverCommand() {
      return sent;
    },
    async uploadAttachment() {
      throw new Error("upload was not expected in this test");
    },
    async downloadAttachment() {
      return new Blob();
    },
    async confirmRevisionRetry() {
      return sent;
    },
    async discardRevisionConflict() {},
    markHistoryLoaded() {},
    async loadLocalHistory() {
      return { messages: [], hasMore: false };
    },
    async loadHistoryPage() {
      return { messages: [], hasMore: false };
    },
    async observeCommandCompletion() {
      return completion;
    },
    async releaseCommand() {},
    stop: onStop,
  } as unknown as MatrixConnection;
}

test("adapts the web Matrix transport without exposing its raw client", async () => {
  const payloads: CommandPayload[] = [];
  const transport = fakeTransport(() => {}, (payload) => payloads.push(payload));
  const client = new WebCodeverClient(transport, config);

  assert.equal(client.runtime, "web");
  assert.equal(client.deviceId, "p256-device");
  assert.equal("client" in client, false);
  await client.ready;

  const sent = await client.send({
    operation: "cancel",
    sessionId: "s1",
    targetCommandId: "turn-1",
  });
  assert.deepEqual(payloads, [{
    operation: "cancel",
    sessionId: "s1",
    targetCommandId: "turn-1",
  }]);
  assert.equal(sent.commandId, "command-1");
  assert.deepEqual(await client.observeCommandCompletion("command-1", 1_000), {
    commandId: "command-1",
    sequence: 1,
    revision: 2,
    outcome: "succeeded",
  });
});

test("keeps UI disposal distinct from an explicit web disconnect", async () => {
  let disposedStops = 0;
  new WebCodeverClient(
    fakeTransport(() => disposedStops += 1),
    config,
  ).dispose();
  assert.equal(disposedStops, 1);

  let disconnectedStops = 0;
  await new WebCodeverClient(
    fakeTransport(() => disconnectedStops += 1),
    config,
  ).disconnect();
  assert.equal(disconnectedStops, 1);
});

test("creates the web client through an injectable transport boundary", async () => {
  const transport = fakeTransport(() => {});
  let receivedConfig: MatrixConnectionConfig | null = null;
  let receivedStatus = "";
  const client = await createWebCodeverClient(
    config,
    {
      onMessage() {},
      onStatus(status) {
        receivedStatus = status;
      },
    },
    {
      async connect(input, handlers) {
        receivedConfig = input;
        handlers.onStatus("connecting");
        return transport;
      },
    },
  );

  assert.equal(client.deviceId, "p256-device");
  assert.deepEqual(receivedConfig, config);
  assert.equal(receivedStatus, "connecting");
});
