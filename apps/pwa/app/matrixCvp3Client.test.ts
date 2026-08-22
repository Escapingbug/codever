import { describe, expect, it, vi } from "vitest";
import {
  CODEVER_MATRIX_EXTENSION,
  type Cvp3Event,
} from "@codever/protocol";
import {
  base64UrlEncode,
  generateCvp3ProjectKey,
  generateDeviceKeyPair,
  sealCvp3Envelope,
  sealCvp3ProjectKeyGrant,
  signCvp3Command,
  signCvp3Event,
} from "@codever/security";
import type { DeviceIdentity } from "./matrix";
import type { TrustedGateway } from "./pairing";
import {
  MatrixCvp3ProtocolClient,
  MemoryMatrixCvp3ClientStore,
  type MatrixCvp3ClientTransport,
} from "./matrixCvp3Client";

describe("MatrixCvp3ProtocolClient", () => {
  it("persists exact commands, quarantines one bad event, and continues projection", async () => {
    const gateway = await generateDeviceKeyPair();
    const device = await generateDeviceKeyPair();
    const projectKey = generateCvp3ProjectKey();
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
    const transport: MatrixCvp3ClientTransport = {
      async sendMessage(input) {
        attempts.push(structuredClone(input));
        if (fail) throw new Error("offline");
        return { eventId: "$command-root" };
      },
    };
    const store = new MemoryMatrixCvp3ClientStore();
    const quarantined: string[] = [];
    const client = new MatrixCvp3ProtocolClient(
      config,
      identity,
      trust,
      transport,
      store,
      undefined,
      (event) => quarantined.push(event.eventId),
    );
    const grantId = "grant-1";
    const sealedGrant = await sealCvp3ProjectKeyGrant({
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
    const forgedSigned = await signCvp3Command(
      forgedCommand,
      attacker.privateKey,
      attacker.keyId,
    );
    const forgedEnvelope = await sealCvp3Envelope({
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
    const terminal: Cvp3Event = {
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
    const signed = await signCvp3Event(terminal, gateway.privateKey, gateway.keyId);
    const envelope = await sealCvp3Envelope({
      plaintext: { kind: "signed_event", value: signed },
      projectKey,
      roomId: config.roomId,
      projectId: config.projectId,
      keyId,
      logicalEventId: terminal.eventId,
    });
    const readyRaw = {
      roomId: config.roomId,
      eventId: "$ready",
      sender: "@gateway:example.org",
      timestamp: 3,
      content: { [CODEVER_MATRIX_EXTENSION]: { version: 3, envelope } },
    };
    await client.ingest(readyRaw);
    await expect(sent.completion).resolves.toMatchObject({
      commandId: sent.commandId,
      outcome: "succeeded",
    });
    expect(client.projection.visibleSessions()).toHaveLength(1);
    expect(store.inbox.get("$bad")?.status).toBe("quarantined");
    expect(store.inbox.get("$forged-local-command")?.status).toBe("quarantined");
    expect(store.inbox.has("$ready")).toBe(false);

    const restarted = new MatrixCvp3ProtocolClient(
      config,
      identity,
      trust,
      transport,
      store,
    );
    await restarted.acceptKeyGrant(grantState);
    expect(restarted.projection.visibleSessions()).toHaveLength(1);
    const currentState = restarted.projection.durableState();

    // Inbox and projection are one rebuildable unit. If the projection is
    // missing, startup discards the incomplete pair instead of replaying an
    // inbox whose size grows for the lifetime of the installation.
    await store.clearProjection();
    const rebuilt = new MatrixCvp3ProtocolClient(
      config,
      identity,
      trust,
      transport,
      store,
    );
    await rebuilt.acceptKeyGrant(grantState);
    expect(rebuilt.projection.visibleSessions()).toHaveLength(0);
    expect(store.inbox.size).toBe(0);
    expect(store.outbox.has(sent.commandId)).toBe(true);
    await rebuilt.ingest(readyRaw);
    expect(rebuilt.projection.visibleSessions()).toHaveLength(1);

    // A current-schema projection remains local-first. Authoritative startup
    // no longer performs an O(total retained events) inbox replay.
    store.projectionState = structuredClone(currentState);
    const listInbox = vi.spyOn(store, "listInbox").mockRejectedValue(
      new Error("a full historical replay must not run"),
    );
    const localFirst = new MatrixCvp3ProtocolClient(
      config,
      identity,
      trust,
      transport,
      store,
    );
    await localFirst.acceptKeyGrant(grantState);
    await localFirst.prepareAuthoritativeRecovery();
    expect(localFirst.projection.visibleSessions()).toHaveLength(1);
    expect(listInbox).not.toHaveBeenCalled();
    listInbox.mockRestore();

    // A previously quarantined valid event must get one fresh attempt when
    // authoritative Matrix history presents the same physical event again.
    store.projectionState = {
      ...currentState,
      sessions: [],
      messages: [],
      seenLogicalEvents: currentState.seenLogicalEvents.filter(id => id !== "ready-1"),
    };
    store.inbox.set("$ready", {
      raw: structuredClone(readyRaw),
      status: "quarantined",
      error: "historical transient failure",
    });
    const quarantinedRecovery = new MatrixCvp3ProtocolClient(
      config,
      identity,
      trust,
      transport,
      store,
    );
    await quarantinedRecovery.acceptKeyGrant(grantState);
    await quarantinedRecovery.prepareAuthoritativeRecovery();
    expect(quarantinedRecovery.projection.visibleSessions()).toHaveLength(0);
    await quarantinedRecovery.ingest(readyRaw);
    expect(quarantinedRecovery.projection.visibleSessions()).toHaveLength(1);
    expect(store.inbox.has("$ready")).toBe(false);

    // A corrupt current projection converges by dropping only Matrix-derived
    // state. The independently durable command remains recoverable.
    class CorruptReadModelStore extends MemoryMatrixCvp3ClientStore {
      resets = 0;
      override async resetRebuildableState() {
        this.resets += 1;
        await super.resetRebuildableState();
      }
    }
    const failingStore = new CorruptReadModelStore();
    failingStore.outbox.set(sent.commandId, structuredClone(store.outbox.get(sent.commandId)!));
    failingStore.inbox.set("$legacy", {
      raw: { ...readyRaw, eventId: "$legacy" },
      status: "projected",
    });
    failingStore.projectionState = { incompatible: true } as never;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repaired = new MatrixCvp3ProtocolClient(
      config,
      identity,
      trust,
      transport,
      failingStore,
    );
    await repaired.acceptKeyGrant(grantState);
    expect(failingStore.resets).toBe(1);
    expect(failingStore.inbox.size).toBe(0);
    expect(failingStore.outbox.has(sent.commandId)).toBe(true);
    await repaired.prepareAuthoritativeRecovery();
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });
});
