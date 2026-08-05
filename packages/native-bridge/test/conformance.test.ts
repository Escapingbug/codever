import { describe, expect, it } from "vitest";
import {
  BridgeProtocolError,
  MUTATION_METHODS,
  NATIVE_BRIDGE_LIMITS,
  RPC_ERROR_NUMBERS,
  failureResponse,
  negotiateHello,
  isMutationMethod,
  parseEventsDeliverNotification,
  parseHelloParams,
  parseHelloResult,
  parseMethodRpcResponse,
  parseRpcError,
  parseRpcRequest,
  parseRpcResponse,
} from "../src/index.js";

const context = { bridgeSessionId: "bridge-session-1" };
const idempotencyKey = "550e8400-e29b-41d4-a716-446655440000";
const webInstanceId = "550e8400-e29b-41d4-a716-446655440001";

function request(method: string, params: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: "request-1",
    method,
    params,
  };
}

function response(result: unknown, id = "request-1") {
  return { jsonrpc: "2.0", id, result };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    deviceId: "native-device-1",
    cursor: "journal-1:42",
    generatedAt: 1_722_000_000_000,
    lifecycle: { phase: "ready", since: 1_721_999_999_000 },
    foregroundService: {
      required: true,
      active: true,
      notificationVisible: true,
    },
    trust: { state: "unpaired" },
    commands: [],
    ...overrides,
  };
}

describe("native bridge JSON-RPC conformance", () => {
  it("strictly parses a version and capability hello", () => {
    const parsed = parseRpcRequest(
      request("codever.bridge.hello", {
        application: "codever-web",
        webBuild: "42cdc51",
        webInstanceId,
        supportedProtocolVersions: [1],
        requiredCapabilities: [
          { name: "commands.durable", versions: [1] },
          { name: "background.foreground-service", versions: [1] },
        ],
        optionalCapabilities: [{ name: "attachments.binary-port", versions: [1] }],
      }),
    );

    expect(parsed.method).toBe("codever.bridge.hello");
    expect(parsed.params.supportedProtocolVersions).toEqual([1]);
  });

  it("rejects unknown hello fields and duplicate capability versions", () => {
    expect(() =>
      parseHelloParams({
        application: "codever-web",
        webBuild: "build",
        webInstanceId,
        supportedProtocolVersions: [1],
        requiredCapabilities: [
          { name: "commands.durable", versions: [1, 1] },
        ],
        optionalCapabilities: [],
        powerSavingMode: true,
      }),
    ).toThrow(BridgeProtocolError);
  });

  it("selects the highest shared versions and fails closed on required capabilities", () => {
    const hello = parseHelloParams({
      application: "codever-web",
      webBuild: "build",
      webInstanceId,
      supportedProtocolVersions: [1, 2],
      requiredCapabilities: [{ name: "commands.durable", versions: [1, 2] }],
      optionalCapabilities: [
        { name: "attachments.chunked", versions: [1] },
        { name: "future.optional", versions: [1] },
      ],
    });
    const support = {
      protocolVersions: [1] as const,
      native: {
        runtimeVersion: "1.0.0",
        runtimeBuild: "android-1",
        platform: "android" as const,
      },
      capabilities: {
        "commands.durable": { versions: [1] },
        "attachments.chunked": {
          versions: [1],
          options: { chunkBytes: 262_144 },
        },
      },
    };

    const result = negotiateHello(hello, support, "bridge-session-1");
    expect(result.protocolVersion).toBe(1);
    expect(result.capabilities).toEqual({
      "commands.durable": { version: 1 },
      "attachments.chunked": {
        version: 1,
        options: { chunkBytes: 262_144 },
      },
    });

    expect(() =>
      negotiateHello(
        { ...hello, requiredCapabilities: [{ name: "trust.native", versions: [1] }] },
        support,
        "bridge-session-1",
      ),
    ).toThrowError(expect.objectContaining({
      errorCode: "CAPABILITY_UNAVAILABLE",
    }));
  });

  it("strictly parses native hello and JSON-RPC responses", () => {
    const result = parseHelloResult({
      protocolVersion: 1,
      bridgeSessionId: "bridge-session-1",
      native: {
        runtimeVersion: "0.1.0",
        runtimeBuild: "android-debug",
        platform: "android",
      },
      capabilities: {
        "background.foreground-service": { version: 1 },
      },
      limits: NATIVE_BRIDGE_LIMITS,
    });
    expect(result.native.platform).toBe("android");
    expect(parseRpcResponse({
      jsonrpc: "2.0",
      id: "request-1",
      result,
    })).toMatchObject({ id: "request-1", result });
    expect(() => parseRpcResponse({
      jsonrpc: "2.0",
      id: "request-1",
      result: {},
      error: { code: -32603, message: "ambiguous", data: {} },
    })).toThrow(/exactly one/);
  });

  it("strictly parses a device-bound start snapshot and correlates response ids", () => {
    const parsed = parseMethodRpcResponse(
      "codever.client.start",
      response({ deviceId: "native-device-1", snapshot: snapshot() }),
      { expectedId: "request-1" },
    );
    expect("result" in parsed && parsed.result.deviceId).toBe("native-device-1");

    expect(() =>
      parseMethodRpcResponse(
        "codever.client.start",
        response({ deviceId: "other-device", snapshot: snapshot() }),
      ),
    ).toThrow(/must match snapshot/);
    expect(() =>
      parseMethodRpcResponse(
        "codever.client.snapshot",
        response(snapshot(), "response-for-another-request"),
        { expectedId: "request-1" },
      ),
    ).toThrow(/does not match/);
  });

  it("bootstraps a public Matrix session with a one-time token only", () => {
    const roomBinding = {
      roomId: "!room:matrix.example",
      gatewayId: "gateway-1",
      conversationId: "conversation-1",
      gatewayUserId: "@gateway:matrix.example",
      gatewayDeviceId: "GATEWAYDEVICE",
      gatewayDeviceEd25519: "a".repeat(43),
    };
    const parsed = parseRpcRequest(request("codever.client.bootstrap", {
      context,
      idempotencyKey,
      homeserver: "https://matrix.example",
      oneTimeLoginToken: "one-time-login-token",
      expectedUserId: "@device:matrix.example",
      deviceName: "Pixel 10",
      roomBinding,
    }));
    expect(parsed.method).toBe("codever.client.bootstrap");

    const result = parseMethodRpcResponse(
      "codever.client.bootstrap",
      response({
        deviceId: "native-device-1",
        session: {
          homeserver: "https://matrix.example",
          userId: "@device:matrix.example",
          matrixDeviceId: "ANDROIDDEVICE",
          roomBinding,
        },
        snapshot: snapshot(),
      }),
    );
    expect("result" in result && result.result.session.matrixDeviceId)
      .toBe("ANDROIDDEVICE");

    expect(() =>
      parseRpcRequest(request("codever.client.bootstrap", {
        context,
        idempotencyKey,
        homeserver: "http://matrix.example",
        oneTimeLoginToken: "one-time-login-token",
        expectedUserId: "@device:matrix.example",
        deviceName: "Pixel 10",
        roomBinding,
      })),
    ).toThrow(/HTTPS/);
    expect(() =>
      parseRpcRequest(request("codever.client.bootstrap", {
        context,
        idempotencyKey,
        homeserver: "https://matrix.example",
        oneTimeLoginToken: "one-time-login-token",
        expectedUserId: "@device:matrix.example",
        deviceName: "Pixel 10",
        roomBinding,
        accessToken: "must-never-cross-the-bridge",
      })),
    ).toThrow(/unknown field: accessToken/);
    expect(() =>
      parseRpcRequest(request("codever.client.bootstrap", {
        context,
        idempotencyKey,
        homeserver: "https://matrix.example",
        oneTimeLoginToken: "one-time-login-token",
        expectedUserId: "@device:matrix.example",
        deviceName: "Pixel 10",
        roomBinding: { ...roomBinding, roomId: "not-a-matrix-room" },
      })),
    ).toThrow(/Matrix room id/);
  });

  it("issues a bounded one-time Matrix token for a completed invitation", () => {
    const parsed = parseRpcRequest(request("codever.matrix.loginToken", {
      context,
      idempotencyKey,
      invitationId: "device-invite-command-1",
    }));
    expect(parsed.method).toBe("codever.matrix.loginToken");

    const ready = parseMethodRpcResponse(
      "codever.matrix.loginToken",
      response({
        status: "ready",
        loginToken: "single-use-login-token",
        expiresAt: 1_722_000_120_000,
      }),
    );
    expect("result" in ready && ready.result.status).toBe("ready");

    const reauth = parseMethodRpcResponse(
      "codever.matrix.loginToken",
      response({ status: "reauth-required", passwordSupported: true }),
    );
    expect(
      "result" in reauth &&
        reauth.result.status === "reauth-required" &&
        reauth.result.passwordSupported,
    ).toBe(true);

    expect(() =>
      parseRpcRequest(request("codever.matrix.loginToken", {
        context,
        idempotencyKey,
        invitationId: "device-invite-command-1",
        password: "x".repeat(4_097),
      })),
    ).toThrow(/password/);
    expect(() =>
      parseMethodRpcResponse(
        "codever.matrix.loginToken",
        response({
          status: "ready",
          loginToken: "single-use-login-token",
          expiresAt: 1_722_000_120_000,
          accessToken: "must-never-cross-the-bridge",
        }),
      ),
    ).toThrow(/unknown field: accessToken/);
  });

  it("parses durable command receipts, completion state, and release", () => {
    const receipt = {
      operationId: "operation-1",
      commandId: "command-1",
      idempotencyKey,
      state: "accepted",
      submittedAt: 1_722_000_000_000,
      updatedAt: 1_722_000_000_100,
      sessionId: "session-1",
      sequence: 4,
      revision: 7,
    };
    const sent = parseMethodRpcResponse(
      "codever.command.send",
      response(receipt),
    );
    expect("result" in sent && sent.result.state).toBe("accepted");

    const completed = parseMethodRpcResponse(
      "codever.command.get",
      response({
        ...receipt,
        state: "succeeded",
        completion: {
          commandId: "command-1",
          sequence: 4,
          revision: 8,
          outcome: "succeeded",
          sessionId: "session-1",
          result: { created: true },
        },
      }),
    );
    expect(
      "result" in completed && completed.result.completion?.outcome,
    ).toBe("succeeded");

    const released = parseMethodRpcResponse(
      "codever.command.release",
      response({ commandId: "command-1", released: true }),
    );
    expect("result" in released && released.result.released).toBe(true);
    expect(() =>
      parseRpcRequest(request("codever.command.release", {
        context,
        commandId: "command-1",
      })),
    ).toThrow(/idempotencyKey/);
  });

  it("uses a native-safe history message DTO without raw Matrix events", () => {
    const page = parseMethodRpcResponse(
      "codever.history.page",
      response({
        sessionId: "session-1",
        messages: [{
          eventId: "event-1",
          sender: "gateway-1",
          timestamp: 1_722_000_000_000,
          encrypted: true,
          kind: "agent",
          text: "done",
          sessionId: "session-1",
          historical: true,
          activeDeviceCount: 2,
          format: "markdown",
          semantic: { type: "agent.text.completed", streamId: "stream-1" },
          toolGroup: {
            kind: "tool_group",
            version: 1,
            groupId: "tool-group-1",
            tools: [{
              id: "tool-1",
              name: "read_file",
              title: "Read file",
              category: "read",
              phase: "completed",
              isError: false,
              startedAt: 1_721_999_999_000,
              updatedAt: 1_722_000_000_000,
            }],
          },
        }],
        hasMore: false,
        asOfCursor: "journal-1:42",
      }),
    );
    expect("result" in page && page.result.messages[0]?.encrypted).toBe(true);

    expect(() =>
      parseMethodRpcResponse(
        "codever.history.page",
        response({
          sessionId: "session-1",
          messages: [{
            eventId: "event-1",
            sender: "gateway-1",
            timestamp: 1,
            encrypted: true,
            kind: "agent",
            format: "plain",
            raw: { matrixEvent: true },
          }],
          hasMore: false,
          asOfCursor: "journal-1:42",
        }),
      ),
    ).toThrow(/unknown field: raw/);
  });

  it("parses native-confirmed pairing without exposing Web private trust state", () => {
    const preview = parseMethodRpcResponse(
      "codever.pairing.inspect",
      response({
        pairingId: "pairing-1",
        gatewayId: "gateway-1",
        gatewayName: "Workstation",
        verificationCode: "123 456",
        expiresAt: 1_722_000_060_000,
        requiresNativeConfirmation: true,
      }),
    );
    expect(
      "result" in preview && preview.result.requiresNativeConfirmation,
    ).toBe(true);

    const trust = {
      state: "trusted",
      gatewayId: "gateway-1",
      gatewayName: "Workstation",
      certificateId: "certificate-1",
      pairedAt: 1_722_000_000_000,
      activeDeviceCount: 2,
    };
    const completed = parseMethodRpcResponse(
      "codever.pairing.complete",
      response({ trust, snapshot: snapshot({ trust }) }),
    );
    expect("result" in completed && completed.result.trust.gatewayId)
      .toBe("gateway-1");
  });

  it("strictly parses resumable attachment chunk results", () => {
    const opened = parseMethodRpcResponse(
      "codever.attachment.upload.open",
      response({
        transferId: "transfer-1",
        chunkBytes: 262_144,
        nextIndex: 0,
        expiresAt: 1_722_000_060_000,
      }),
    );
    expect("result" in opened && opened.result.nextIndex).toBe(0);

    const chunk = parseMethodRpcResponse(
      "codever.attachment.upload.chunk",
      response({
        transferId: "transfer-1",
        index: 0,
        receivedBytes: 128,
        nextIndex: 1,
      }),
    );
    expect("result" in chunk && chunk.result.receivedBytes).toBe(128);

    const digest = "a".repeat(43);
    const downloaded = parseMethodRpcResponse(
      "codever.attachment.download.read",
      response({
        transferId: "transfer-2",
        index: 0,
        dataBase64Url: "YWJj",
        chunkSha256: digest,
        eof: true,
      }),
    );
    expect("result" in downloaded && downloaded.result.eof).toBe(true);
  });

  it.each([
    ["missing id", { jsonrpc: "2.0", method: "codever.trust.get", params: { context } }],
    ["numeric id", { ...request("codever.trust.get", { context }), id: 1 }],
    ["batch", [request("codever.trust.get", { context })]],
    ["unknown method", request("codever.native.eval", { context })],
    ["unknown field", { ...request("codever.trust.get", { context }), origin: "https://evil.test" }],
  ])("rejects %s", (_label, input) => {
    expect(() => parseRpcRequest(input)).toThrow(BridgeProtocolError);
  });

  it("enforces byte and nesting limits before dispatch", () => {
    expect(() =>
      parseRpcRequest(JSON.stringify(request("codever.pairing.inspect", {
        context,
        link: "x".repeat(512),
      })), { maxBytes: 128 }),
    ).toThrow(/size limit/);

    let nested: unknown = "leaf";
    for (let index = 0; index < 6; index += 1) nested = [nested];
    expect(() => parseRpcRequest(nested, { maxDepth: 3 })).toThrow(/depth limit/);
  });

  it("requires a UUID idempotency key for every declared mutation", () => {
    expect(MUTATION_METHODS.every(isMutationMethod)).toBe(true);
    expect(() =>
      parseRpcRequest(request("codever.command.recover", {
        context,
        commandId: "command-1",
      })),
    ).toThrow(/idempotencyKey/);

    expect(
      parseRpcRequest(request("codever.command.recover", {
        context,
        idempotencyKey,
        commandId: "command-1",
      })).params.idempotencyKey,
    ).toBe(idempotencyKey);
  });

  it("does not require idempotency keys for reads or monotonic event acknowledgement", () => {
    expect(parseRpcRequest(request("codever.client.snapshot", { context })).method)
      .toBe("codever.client.snapshot");
    expect(parseRpcRequest(request("codever.events.ack", {
      context,
      subscriptionId: "subscription-1",
      throughCursor: "journal-1:42",
    })).method).toBe("codever.events.ack");
  });

  it("strictly validates replay subscription and activation cursors", () => {
    const subscribe = parseRpcRequest(request("codever.events.subscribe", {
      context,
      afterCursor: "journal-1:41",
      maxReplayEvents: 100,
    }));
    expect(subscribe.params.afterCursor).toBe("journal-1:41");

    expect(() =>
      parseRpcRequest(request("codever.events.subscribe", {
        context,
        maxReplayEvents: NATIVE_BRIDGE_LIMITS.maxReplayEvents + 1,
      })),
    ).toThrow(/maxReplayEvents/);

    expect(() =>
      parseRpcRequest(request("codever.events.activate", {
        context,
        subscriptionId: "subscription-1",
      })),
    ).toThrow(/throughCursor/);
  });

  it("parses only bounded, negotiated native event notifications", () => {
    const notification = parseEventsDeliverNotification({
      jsonrpc: "2.0",
      method: "codever.events.deliver",
      params: {
        subscriptionId: "subscription-1",
        events: [{
          schemaVersion: 1,
          eventId: "event-1",
          cursor: "journal-1:42",
          occurredAt: 1_722_000_000_000,
          type: "command.changed",
          payload: { operationId: "operation-1", state: "accepted" },
        }],
      },
    });
    expect(notification.params.events[0]?.cursor).toBe("journal-1:42");

    expect(() =>
      parseEventsDeliverNotification({
        ...notification,
        params: {
          ...notification.params,
          events: [{ ...notification.params.events[0], type: "native.secret.exposed" }],
        },
      }),
    ).toThrow(/not negotiated/);
  });

  it("validates attachment metadata and bounds chunk payloads", () => {
    const digest = "a".repeat(43);
    const upload = parseRpcRequest(request("codever.attachment.upload.open", {
      context,
      idempotencyKey,
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 1024,
      sha256: digest,
    }));
    expect(upload.params.size).toBe(1024);

    try {
      parseRpcRequest(request("codever.attachment.upload.open", {
        context,
        idempotencyKey,
        name: "too-large.bin",
        mimeType: "application/octet-stream",
        size: NATIVE_BRIDGE_LIMITS.maxAttachmentBytes + 1,
        sha256: digest,
      }));
      throw new Error("Expected the oversized attachment to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ errorCode: "ATTACHMENT_TOO_LARGE" });
    }
  });

  it("uses stable machine-readable errors and preserves retry metadata", () => {
    const error = parseRpcError({
      code: RPC_ERROR_NUMBERS.TIMEOUT,
      message: "The native operation is still pending.",
      data: {
        errorCode: "TIMEOUT",
        retryable: true,
        retryAfterMs: 1000,
        operationId: "operation-1",
        userAction: "retry",
      },
    });
    expect(error.data).toMatchObject({
      errorCode: "TIMEOUT",
      retryable: true,
      operationId: "operation-1",
    });

    const failure = failureResponse(
      "request-1",
      new BridgeProtocolError("CURSOR_EXPIRED", "Snapshot required.", {
        retryable: true,
      }),
    );
    expect(failure.error.code).toBe(RPC_ERROR_NUMBERS.CURSOR_EXPIRED);
  });
});
