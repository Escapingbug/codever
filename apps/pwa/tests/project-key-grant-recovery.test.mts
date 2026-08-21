import assert from "node:assert/strict";
import test from "node:test";
import {
  findMatchingProjectKeyGrant,
  resolveAuthoritativeProjectKeyGrant,
} from "../app/projectKeyGrantRecovery.ts";

const expected = {
  workspaceId: "workspace-1",
  projectId: "project-1",
  roomId: "!project:example.org",
  deviceId: "device-1",
  certificateId: "certificate-2",
};

test("opens the exact device and certificate grant", () => {
  const grant = projectKeyGrant();
  assert.equal(findMatchingProjectKeyGrant([grant], expected)?.grantId, "grant-1");
  assert.deepEqual(resolveAuthoritativeProjectKeyGrant(grant, expected), {
    kind: "matched",
    grant,
  });
});

test("requires reauthorization when authoritative state retains an older certificate", () => {
  assert.deepEqual(
    resolveAuthoritativeProjectKeyGrant(
      projectKeyGrant({ certificateId: "certificate-1" }),
      expected,
    ),
    {
      kind: "reauthorization-required",
      reason: "certificate-mismatch",
    },
  );
});

test("requires reauthorization when the addressed grant is absent or invalid", () => {
  assert.deepEqual(resolveAuthoritativeProjectKeyGrant(null, expected), {
    kind: "reauthorization-required",
    reason: "missing",
  });
  assert.deepEqual(
    resolveAuthoritativeProjectKeyGrant({ kind: "project.key_grant" }, expected),
    { kind: "reauthorization-required", reason: "malformed" },
  );
  assert.deepEqual(
    resolveAuthoritativeProjectKeyGrant(
      projectKeyGrant({ deviceId: "another-device" }),
      expected,
    ),
    { kind: "reauthorization-required", reason: "binding-mismatch" },
  );
});

function projectKeyGrant(
  overrides: Partial<ReturnType<typeof projectKeyGrantBase>> = {},
) {
  return { ...projectKeyGrantBase(), ...overrides };
}

function projectKeyGrantBase() {
  return {
    kind: "project.key_grant" as const,
    version: 3 as const,
    workspaceId: "workspace-1",
    projectId: "project-1",
    roomId: "!project:example.org",
    deviceId: "device-1",
    certificateId: "certificate-2",
    grantId: "grant-1",
    sealedGrant: {
      envelope: {
        kind: "codever.project-key-grant-envelope" as const,
        version: 3 as const,
        grantId: "grant-1",
        workspaceId: "workspace-1",
        projectId: "project-1",
        roomId: "!project:example.org",
        deviceId: "device-1",
        certificateId: "certificate-2",
        senderKeyId: "A".repeat(43),
        recipientKeyId: "B".repeat(43),
        nonce: "C".repeat(16),
        ciphertext: "D".repeat(22),
      },
      signature: {
        algorithm: "ES256" as const,
        keyId: "gateway-key",
        value: "signature",
      },
    },
  };
}

