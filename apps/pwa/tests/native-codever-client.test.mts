import assert from "node:assert/strict";
import test from "node:test";
import {
  BridgeProtocolError,
  NATIVE_BRIDGE_LIMITS,
  type BridgeMethodParams,
  type CapabilityName,
  type ClientSnapshot,
  type HelloResult,
  type RequestMethod,
} from "@codever/native-bridge";
import {
  NativeBridgeClient,
  OPTIONAL_NATIVE_CAPABILITIES,
  REQUIRED_NATIVE_CAPABILITIES,
  nativeCapabilityVersions,
} from "../app/client/native/NativeBridgeClient.ts";
import {
  acquireNativeRpcBridge,
  type NativeBridgePort,
} from "../app/client/native/NativeRpcBridge.ts";
import {
  CommandReviewRequiredError,
  type CodeverCommandReview,
} from "../app/client/CodeverClient.ts";

type Request = {
  jsonrpc: "2.0";
  id: string;
  method: RequestMethod;
  params: BridgeMethodParams[RequestMethod];
};

const NO_RESPONSE = Symbol("no native response");

class RuntimePort implements NativeBridgePort {
  onmessage: NativeBridgePort["onmessage"] = null;
  readonly requests: Request[] = [];

  constructor(
    private readonly responder: (request: Request) => unknown = responseFor,
  ) {}

  postMessage(message: string): void {
    const request = JSON.parse(message) as Request;
    this.requests.push(request);
    queueMicrotask(() => this.#respond(request));
  }

  deliver(notification: unknown): void {
    this.onmessage?.({ data: JSON.stringify(notification) });
  }

  #respond(request: Request): void {
    try {
      const result = this.responder(request);
      if (result === NO_RESPONSE) return;
      this.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      });
    } catch (error) {
      if (!(error instanceof BridgeProtocolError)) throw error;
      this.onmessage?.({
        data: JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: error.toRpcError(),
        }),
      });
    }
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
      versions: nativeCapabilityVersions(name),
    })).concat(OPTIONAL_NATIVE_CAPABILITIES.map((name) => ({
      name,
      versions: [1],
    }))),
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

  const pendingSend = client.send({
    operation: "cancel",
    sessionId: "s1",
    targetCommandId: "turn-1",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const commandRequest = port.requests.find(
    (request) => request.method === "codever.command.send",
  );
  assert.deepEqual(
    (commandRequest?.params as BridgeMethodParams["codever.command.send"] | undefined)?.payload,
    {
      operation: "cancel",
      sessionId: "s1",
      targetCommandId: "turn-1",
    },
  );
  port.deliver({
    jsonrpc: "2.0",
    method: "codever.events.deliver",
    params: {
      subscriptionId: "subscription-1",
      events: [
        {
          schemaVersion: 1,
          eventId: "event-command-ack-1",
          cursor: "cursor-event-ack-1",
          occurredAt: 2,
          type: "command.changed",
          payload: {
            operationId: "operation-1",
            commandId: "command-1",
            idempotencyKey: "00000000-0000-4000-8000-000000000001",
            state: "accepted",
            submittedAt: 1,
            updatedAt: 2,
            sequence: 1,
            revision: 4,
          },
        },
      ],
    },
  });
  const sent = await pendingSend;
  assert.equal(sent.commandId, "command-1");
  assert.equal(sent.revision, 4);
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
  assert.deepEqual(savedCursors, [
    "cursor-barrier-1",
    "cursor-event-ack-1",
    "cursor-event-2",
  ]);
  assert.ok(port.requests.some((request) => request.method === "codever.events.ack"));

  const token = await client.requestMatrixLoginToken("invite-command-1");
  assert.deepEqual(token, {
    status: "ready",
    loginToken: "single-use-token",
    expiresAt: 120_000,
  });
  const tokenRequest = port.requests.find(
    (request) => request.method === "codever.matrix.loginToken",
  );
  assert.ok(tokenRequest);
  assert.equal(
    (tokenRequest.params as BridgeMethodParams["codever.matrix.loginToken"])
      .invitationId,
    "invite-command-1",
  );
  assert.equal(JSON.stringify(tokenRequest).includes("accessToken"), false);

  client.dispose();
  assert.equal(port.onmessage, null);
  assert.ok(
    port.requests.some((request) => request.method === "codever.events.unsubscribe"),
  );
  const replacement = await acquireNativeRpcBridge(port);
  replacement.close();
});

test("follows an automatically rebased session deletion by operation identity", async () => {
  const port = new RuntimePort((request) => {
    if (request.method !== "codever.command.send") return responseFor(request);
    const params = request.params as BridgeMethodParams["codever.command.send"];
    return {
      operationId: "operation-rebased-1",
      commandId: "command-original-1",
      idempotencyKey: params.idempotencyKey,
      state: "transmitting",
      submittedAt: 1,
      updatedAt: 1,
      sequence: 2,
    };
  });
  const client = await createTestClient(port);
  const pending = client.send({
    operation: "session.delete",
    sessionId: "session-delete-1",
  });
  await nextTurn();
  deliverCommand(port, {
    operationId: "operation-rebased-1",
    commandId: "command-rebased-1",
    idempotencyKey: "00000000-0000-4000-8000-000000000002",
    state: "accepted",
    submittedAt: 1,
    updatedAt: 3,
    sequence: 2,
    revision: 8,
  }, "cursor-rebased-ack");

  const sent = await pending;
  assert.equal(sent.commandId, "command-rebased-1");
  assert.equal(sent.revision, 8);
  deliverCommand(port, {
    operationId: "operation-rebased-1",
    commandId: "command-rebased-1",
    idempotencyKey: "00000000-0000-4000-8000-000000000002",
    state: "succeeded",
    submittedAt: 1,
    updatedAt: 4,
    sequence: 2,
    revision: 8,
    completion: {
      commandId: "command-rebased-1",
      sequence: 2,
      revision: 8,
      outcome: "succeeded",
      sessionId: "session-delete-1",
    },
  }, "cursor-rebased-result");
  assert.equal((await sent.completion).sessionId, "session-delete-1");
  client.dispose();
});

test("follows a Gateway epoch re-key even when its command sequence restarts", async () => {
  const port = new RuntimePort((request) => {
    if (request.method !== "codever.command.send") return responseFor(request);
    const params = request.params as BridgeMethodParams["codever.command.send"];
    return {
      operationId: "operation-epoch-rekey-1",
      commandId: "command-retired-9",
      idempotencyKey: params.idempotencyKey,
      state: "transmitting",
      submittedAt: 1,
      updatedAt: 1,
      sequence: 9,
    };
  });
  const client = await createTestClient(port);
  const pending = client.send({ operation: "prompt", sessionId: "session-1", text: "hello" });
  await nextTurn();
  deliverCommand(port, {
    operationId: "operation-epoch-rekey-1",
    commandId: "command-current-1",
    idempotencyKey: "00000000-0000-4000-8000-000000000009",
    state: "accepted",
    submittedAt: 1,
    updatedAt: 3,
    sequence: 1,
    revision: 2,
  }, "cursor-epoch-rekey-ack");

  const sent = await pending;
  assert.equal(sent.commandId, "command-current-1");
  assert.equal(sent.sequence, 1);
  deliverCommand(port, {
    operationId: "operation-epoch-rekey-1",
    commandId: "command-current-1",
    idempotencyKey: "00000000-0000-4000-8000-000000000009",
    state: "succeeded",
    submittedAt: 1,
    updatedAt: 4,
    sequence: 1,
    revision: 2,
    sessionId: "session-1",
    completion: {
      commandId: "command-current-1",
      sequence: 1,
      revision: 2,
      outcome: "succeeded",
      sessionId: "session-1",
    },
  }, "cursor-epoch-rekey-result");
  assert.equal((await sent.completion).commandId, "command-current-1");
  client.dispose();
});

test("waits for transient outbox recovery with one idempotency key", async () => {
  let attempts = 0;
  const port = new RuntimePort((request) => {
    if (request.method !== "codever.command.send") return responseFor(request);
    attempts += 1;
    if (attempts === 1) {
      throw new BridgeProtocolError(
        "INVALID_STATE",
        "Codever is restoring the previous queued action.",
        {
          retryable: true,
          retryAfterMs: 1,
          userAction: "retry",
          details: {
            kind: "command_blocked",
            commandId: "command-blocking-1",
            state: "recovery_required",
            operation: "prompt",
          },
        },
      );
    }
    const params = request.params as BridgeMethodParams["codever.command.send"];
    return {
      operationId: "operation-after-recovery-1",
      commandId: "command-after-recovery-1",
      idempotencyKey: params.idempotencyKey,
      state: "accepted",
      submittedAt: 2,
      updatedAt: 2,
      sequence: 3,
      revision: 9,
    };
  });
  const client = await createTestClient(port);
  const sent = await client.send({ operation: "session.create" });
  const sends = port.requests.filter((request) => request.method === "codever.command.send");
  assert.equal(sends.length, 2);
  assert.equal(
    (sends[0]!.params as BridgeMethodParams["codever.command.send"]).idempotencyKey,
    (sends[1]!.params as BridgeMethodParams["codever.command.send"]).idempotencyKey,
  );
  deliverCommand(port, {
    operationId: sent.operationId,
    commandId: sent.commandId,
    idempotencyKey:
      (sends[1]!.params as BridgeMethodParams["codever.command.send"]).idempotencyKey,
    state: "succeeded",
    submittedAt: 2,
    updatedAt: 3,
    sequence: sent.sequence,
    revision: sent.revision,
    completion: {
      commandId: sent.commandId,
      sequence: sent.sequence,
      revision: sent.revision,
      outcome: "succeeded",
    },
  }, "cursor-recovered-result");
  await sent.completion;
  client.dispose();
});

test("hydrates a completed recovered command when its terminal event preceded the WebView", async () => {
  const completion = {
    commandId: "command-completed-before-webview",
    sequence: 7,
    revision: 19,
    outcome: "succeeded" as const,
    sessionId: "session-created-before-webview",
  };
  const port = new RuntimePort((request) => {
    if (request.method === "codever.command.recover") {
      return {
        operationId: "operation-completed-before-webview",
        commandId: completion.commandId,
        idempotencyKey: "00000000-0000-4000-8000-000000000007",
        state: "succeeded",
        submittedAt: 1,
        updatedAt: 3,
        sequence: completion.sequence,
        revision: completion.revision,
      };
    }
    if (request.method === "codever.command.get") {
      return {
        operationId: "operation-completed-before-webview",
        commandId: completion.commandId,
        idempotencyKey: "00000000-0000-4000-8000-000000000007",
        state: "succeeded",
        submittedAt: 1,
        updatedAt: 3,
        sequence: completion.sequence,
        revision: completion.revision,
        completion,
      };
    }
    return responseFor(request);
  });
  const client = await createTestClient(port);

  const recovered = await client.recoverCommand(completion.commandId);

  assert.deepEqual(await recovered.completion, completion);
  assert.deepEqual(
    port.requests
      .filter((request) => request.method.startsWith("codever.command."))
      .map((request) => request.method),
    ["codever.command.recover", "codever.command.get"],
  );
  client.dispose();
});

test("detaching the WebView waiter does not cancel a native-confirmed pairing", async () => {
  const port = new RuntimePort((request) => {
    if (request.method === "codever.pairing.inspect") {
      return {
        pairingId: "pairing-one",
        gatewayId: "gateway-one",
        gatewayName: "Gateway",
        verificationCode: "123 456",
        expiresAt: Date.now() + 60_000,
        requiresNativeConfirmation: true,
      };
    }
    if (request.method === "codever.pairing.complete") {
      return NO_RESPONSE;
    }
    return responseFor(request);
  });
  const client = await createTestClient(port);
  const abort = new AbortController();
  const pairing = client.pair("codever://pair?data=fixture", "Phone", abort.signal);
  await nextTurn();

  abort.abort();

  await assert.rejects(pairing, (error) =>
    error instanceof DOMException && error.name === "AbortError"
  );
  assert.equal(
    port.requests.some((request) => request.method === "codever.pairing.cancel"),
    false,
  );
  client.dispose();
});

test("surfaces a review-required blocker with its operation immediately", async () => {
  const reviews: string[] = [];
  const port = new RuntimePort((request) => {
    if (request.method !== "codever.command.send") return responseFor(request);
    throw new BridgeProtocolError(
      "INVALID_STATE",
      "The previous Codever action needs review before another action can start.",
      {
        details: {
          kind: "command_blocked",
          commandId: "command-review-1",
          state: "needs_review",
          operation: "session.delete",
          expectedRevision: 12,
        },
      },
    );
  });
  const client = await createTestClient(port, (review) => {
    if (review) {
      reviews.push(
        `${review.commandId}:${review.operation}:${review.expectedRevision}`,
      );
    }
  });
  await assert.rejects(
    client.send({ operation: "session.create" }),
    (error) => error instanceof CommandReviewRequiredError &&
      error.review.commandId === "command-review-1" &&
      error.review.operation === "session.delete" &&
      error.review.expectedRevision === 12,
  );
  assert.deepEqual(reviews, ["command-review-1:session.delete:12"]);
  client.dispose();
});

test("clears a startup review after native safely resumes the operation", async () => {
  const changes: Array<string | null> = [];
  const port = new RuntimePort();
  const client = await createTestClient(port, (review) => {
    changes.push(review?.commandId ?? null);
  });
  const common = {
    operationId: "operation-startup-review-1",
    idempotencyKey: "00000000-0000-4000-8000-000000000004",
    submittedAt: 1,
    sequence: 4,
  };
  deliverCommand(port, {
    ...common,
    commandId: "command-startup-review-1",
    state: "needs_review",
    updatedAt: 2,
  }, "cursor-startup-review");
  deliverCommand(port, {
    ...common,
    commandId: "command-startup-rebased-1",
    state: "queued",
    updatedAt: 3,
  }, "cursor-startup-rebased");
  await nextTurn();
  assert.deepEqual(changes, ["command-startup-review-1", null]);
  client.dispose();
});

test("recovers structured tool cards from older native agent messages", async () => {
  const messages: Array<Record<string, unknown>> = [];
  const port = new RuntimePort();
  const bridge = await acquireNativeRpcBridge(port);
  const hello = await bridge.hello({
    webBuild: "test-build",
    requiredCapabilities: [],
    optionalCapabilities: REQUIRED_NATIVE_CAPABILITIES.map((name) => ({
      name,
      versions: nativeCapabilityVersions(name),
    })),
  });
  const client = new NativeBridgeClient(bridge, hello, {
    onMessage(message) {
      messages.push(message as unknown as Record<string, unknown>);
    },
    onStatus() {},
  });
  await client.ready;

  port.deliver({
    jsonrpc: "2.0",
    method: "codever.events.deliver",
    params: {
      subscriptionId: "subscription-1",
      events: [{
        schemaVersion: 1,
        eventId: "event-old-native-tool-1",
        cursor: "cursor-old-native-tool-1",
        occurredAt: 10,
        type: "message.upserted",
        payload: {
          eventId: "assistant:tool-message-1:0",
          sender: "gateway-1",
          timestamp: 10,
          encrypted: true,
          kind: "agent",
          text: "Bash",
          sessionId: "session-1",
          format: "plain",
          semantic: {
            type: "assistant.message",
            messageId: "tool-message-1",
            messageVersion: 1,
            ui: {
              kind: "tool_group",
              version: 1,
              groupId: "bash-1",
              tools: [{
                id: "bash-1",
                name: "Bash",
                title: "Bash",
                detail: "pnpm test",
                category: "execute",
                phase: "completed",
                isError: false,
                startedAt: 1,
                updatedAt: 10,
              }],
            },
          },
        },
      }],
    },
  });
  await nextTurn();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "tool");
  assert.deepEqual(messages[0].toolGroup, {
    kind: "tool_group",
    version: 1,
    groupId: "bash-1",
    tools: [{
      id: "bash-1",
      name: "Bash",
      title: "Bash",
      detail: "pnpm test",
      category: "execute",
      phase: "completed",
      isError: false,
      startedAt: 1,
      updatedAt: 10,
    }],
  });
  client.dispose();
});

test("reports and installs an APK release already received from the Gateway", async () => {
  const port = new RuntimePort();
  const client = await createTestClient(port);

  assert.equal((await client.nativeUpdateStatus()).phase, "ready");
  assert.equal((await client.installNativeUpdate()).phase, "installing");
  const install = port.requests.find((request) => request.method === "codever.update.install");
  assert.match(
    (install?.params as BridgeMethodParams["codever.update.install"]).idempotencyKey,
    /^[0-9a-f-]{36}$/,
  );
  client.dispose();
});

async function createTestClient(
  port: RuntimePort,
  onReview: (review: CodeverCommandReview | null) => void = () => {},
): Promise<NativeBridgeClient> {
  const bridge = await acquireNativeRpcBridge(port);
  const hello = await bridge.hello({
    webBuild: "test-build",
    requiredCapabilities: [],
    optionalCapabilities: [
      ...REQUIRED_NATIVE_CAPABILITIES,
      ...OPTIONAL_NATIVE_CAPABILITIES,
    ].map((name) => ({
      name,
      versions: nativeCapabilityVersions(name),
    })),
  });
  const client = new NativeBridgeClient(bridge, hello, {
    onMessage() {},
    onStatus() {},
    onCommandReviewRequired: onReview,
  });
  await client.ready;
  return client;
}

function deliverCommand(
  port: RuntimePort,
  payload: Record<string, unknown>,
  cursor: string,
): void {
  port.deliver({
    jsonrpc: "2.0",
    method: "codever.events.deliver",
    params: {
      subscriptionId: "subscription-1",
      events: [{
        schemaVersion: 1,
        eventId: `event-${cursor}`,
        cursor,
        occurredAt: Date.now(),
        type: "command.changed",
        payload,
      }],
    },
  });
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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
        state: "transmitting",
        submittedAt: 1,
        updatedAt: 1,
        sessionId: "s1",
        sequence: 1,
      };
    }
    case "codever.matrix.loginToken":
      return {
        status: "ready",
        loginToken: "single-use-token",
        expiresAt: 120_000,
      };
    case "codever.update.status":
      return nativeUpdateStatus("ready");
    case "codever.update.install":
      return nativeUpdateStatus("installing");
    default:
      throw new Error(`Unexpected native method in test: ${request.method}`);
  }
}

function nativeUpdateStatus(phase: "ready" | "installing") {
  return {
    phase,
    currentVersionCode: 41,
    currentVersionName: "0.1.0-alpha.41",
    latestVersionCode: 42,
    latestVersionName: "0.1.0-alpha.42",
    buildId: "android-alpha-42",
    totalBytes: 1_000,
    checkedAt: 1_787_400_000_000,
  };
}

function helloResult(): HelloResult {
  const capabilities = Object.fromEntries(
    [...REQUIRED_NATIVE_CAPABILITIES, ...OPTIONAL_NATIVE_CAPABILITIES]
      .map((name) => [name, { version: nativeCapabilityVersions(name)[0] }]),
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
