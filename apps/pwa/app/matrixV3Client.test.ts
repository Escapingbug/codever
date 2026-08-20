import { describe, expect, it } from "vitest";
import {
  CODEVER_MATRIX_EXTENSION,
  type CodeverV3Event,
} from "@codever/protocol";
import {
  base64UrlEncode,
  generateCodeverV3ProjectKey,
  generateDeviceKeyPair,
  sealCodeverV3Envelope,
  sealCodeverV3ProjectKeyGrant,
  signCodeverV3Command,
  signCodeverV3Event,
} from "@codever/security";
import type { DeviceIdentity } from "./matrix";
import type { TrustedGateway } from "./pairing";
import {
  MatrixV3ProtocolClient,
  MemoryMatrixV3ClientStore,
  type MatrixV3ClientTransport,
} from "./matrixV3Client";

describe("MatrixV3ProtocolClient", () => {
  it("persists exact commands, quarantines one bad event, and continues projection", async () => {
    const gateway = await generateDeviceKeyPair();
    const device = await generateDeviceKeyPair();
    const projectKey = generateCodeverV3ProjectKey();
    const keyId = "project-key-1";
    const config = {
      workspaceId: "workspace-1",
      roomId: "!project:example.org",
      projectId: "project-1",
    };
    const trust = {
      gatewayKey: { keyId: gateway.keyId, publicKey: gateway.publicJwk },
      certificate: {
        certificate: {
          deviceId: device.keyId,
          certificateId: "certificate-1",
        },
      },
    } as TrustedGateway;
    const identity: DeviceIdentity = device;
    const attempts: Array<{ content: Record<string, unknown>; transactionId: string }> = [];
    let fail = true;
    const transport: MatrixV3ClientTransport = {
      async sendMessage(input) {
        attempts.push(structuredClone(input));
        if (fail) throw new Error("offline");
        return { eventId: "$command-root" };
      },
    };
    const store = new MemoryMatrixV3ClientStore();
    const quarantined: string[] = [];
    const client = new MatrixV3ProtocolClient(
      config,
      identity,
      trust,
      transport,
      store,
      undefined,
      (event) => quarantined.push(event.eventId),
    );
    const grantId = "grant-1";
    const sealedGrant = await sealCodeverV3ProjectKeyGrant({
      plaintext: {
        kind: "project.key_grant",
        version: 3,
        ...config,
        deviceId: device.keyId,
        certificateId: "certificate-1",
        activeKeyId: keyId,
        keys: [{ keyId, key: base64UrlEncode(projectKey), createdAt: 1 }],
      },
      bindings: {
        grantId,
        ...config,
        deviceId: device.keyId,
        certificateId: "certificate-1",
        senderKeyId: gateway.keyId,
        recipientKeyId: device.keyId,
      },
      senderPrivateKey: gateway.privateKey,
      recipientPublicKey: device.publicKey,
    });
    const grantState = {
      kind: "project.key_grant",
      version: 3,
      ...config,
      deviceId: device.keyId,
      certificateId: "certificate-1",
      grantId,
      sealedGrant,
    } as const;
    await client.acceptKeyGrant(grantState);

    const sent = await client.send({ operation: "session.create" });
    expect(store.outbox.get(sent.commandId)?.status).toBe("pending");
    expect(attempts).toHaveLength(1);
    fail = false;
    await client.retryPending();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await client.retryPending();
    expect(attempts).toHaveLength(2);

    await client.ingest({
      roomId: config.roomId,
      eventId: "$bad",
      sender: "@gateway:example.org",
      timestamp: 2,
      content: {
        [CODEVER_MATRIX_EXTENSION]: { version: 3, envelope: { malformed: true } },
      },
    });
    expect(quarantined).toEqual(["$bad"]);

    const attacker = await generateDeviceKeyPair();
    const forgedCommand = {
      kind: "codever.command" as const,
      version: 3 as const,
      commandId: "forged-local-command",
      workspaceId: config.workspaceId,
      projectId: config.projectId,
      sessionId: "forged-session",
      deviceId: device.keyId,
      certificateId: "certificate-1",
      createdAt: 2,
      operation: "session.create" as const,
      payload: { operation: "session.create" as const },
    };
    const forgedSigned = await signCodeverV3Command(
      forgedCommand,
      attacker.privateKey,
      attacker.keyId,
    );
    const forgedEnvelope = await sealCodeverV3Envelope({
      plaintext: { kind: "signed_command", value: forgedSigned },
      projectKey,
      roomId: config.roomId,
      projectId: config.projectId,
      keyId,
      logicalEventId: forgedCommand.commandId,
    });
    await client.ingest({
      roomId: config.roomId,
      eventId: "$forged-local-command",
      sender: "@attacker:example.org",
      timestamp: 2,
      content: { [CODEVER_MATRIX_EXTENSION]: { version: 3, envelope: forgedEnvelope } },
    });
    expect(quarantined).toEqual(["$bad", "$forged-local-command"]);

    const command = store.outbox.get(sent.commandId)!.command;
    const terminal: CodeverV3Event = {
      kind: "codever.event",
      version: 3,
      eventId: "ready-1",
      workspaceId: config.workspaceId,
      projectId: config.projectId,
      sessionId: command.sessionId,
      occurredAt: 3,
      causationCommandId: command.commandId,
      payload: {
        type: "session.ready",
        rootCommandId: command.commandId,
        originDeviceId: device.keyId,
        projection: {
          title: "New session",
          lifecycle: "active",
          activity: "idle",
          updatedAt: 3,
          stateVersion: 1,
        },
        provider: "test",
        permissionMode: "default",
      },
    };
    const signed = await signCodeverV3Event(terminal, gateway.privateKey, gateway.keyId);
    const envelope = await sealCodeverV3Envelope({
      plaintext: { kind: "signed_event", value: signed },
      projectKey,
      roomId: config.roomId,
      projectId: config.projectId,
      keyId,
      logicalEventId: terminal.eventId,
    });
    await client.ingest({
      roomId: config.roomId,
      eventId: "$ready",
      sender: "@gateway:example.org",
      timestamp: 3,
      content: { [CODEVER_MATRIX_EXTENSION]: { version: 3, envelope } },
    });
    await expect(sent.completion).resolves.toMatchObject({
      commandId: sent.commandId,
      outcome: "succeeded",
    });
    expect(client.projection.visibleSessions()).toHaveLength(1);
    expect(store.inbox.get("$bad")?.status).toBe("quarantined");
    expect(store.inbox.get("$forged-local-command")?.status).toBe("quarantined");
    expect(store.inbox.get("$ready")?.status).toBe("projected");

    const restarted = new MatrixV3ProtocolClient(
      config,
      identity,
      trust,
      transport,
      store,
    );
    await restarted.acceptKeyGrant(grantState);
    expect(restarted.projection.visibleSessions()).toHaveLength(1);

    // A missing/corrupt rebuildable projection must recover from durable raw
    // inbox events instead of treating their projected status as a reason to
    // skip them forever.
    await store.clearProjection();
    const rebuilt = new MatrixV3ProtocolClient(
      config,
      identity,
      trust,
      transport,
      store,
    );
    await rebuilt.acceptKeyGrant(grantState);
    expect(rebuilt.projection.visibleSessions()).toHaveLength(1);
    expect(store.inbox.get("$bad")?.status).toBe("quarantined");
  });
});
