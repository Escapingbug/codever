import {
  cvp3ProjectKeyGrantStateSchema,
} from "@codever/protocol";

export const MATRIX_PROJECT_AUTHORIZATION_REPAIR_REQUIRED =
  "matrix_project_authorization_repair_required";

export type ProjectKeyGrant = ReturnType<
  typeof cvp3ProjectKeyGrantStateSchema.parse
>;

export type ProjectKeyGrantBinding = {
  workspaceId: string;
  projectId: string;
  roomId: string;
  deviceId: string;
  certificateId: string;
};

export type AuthoritativeProjectKeyGrantResolution =
  | { kind: "matched"; grant: ProjectKeyGrant }
  | {
      kind: "reauthorization-required";
      reason: "missing" | "malformed" | "binding-mismatch" | "certificate-mismatch";
    };

export function findMatchingProjectKeyGrant(
  candidates: readonly unknown[],
  expected: ProjectKeyGrantBinding,
): ProjectKeyGrant | null {
  for (const candidate of candidates) {
    const parsed = cvp3ProjectKeyGrantStateSchema.safeParse(candidate);
    if (parsed.success && projectKeyGrantMatches(parsed.data, expected)) {
      return parsed.data;
    }
  }
  return null;
}

export function resolveAuthoritativeProjectKeyGrant(
  candidate: unknown | null,
  expected: ProjectKeyGrantBinding,
): AuthoritativeProjectKeyGrantResolution {
  if (candidate === null) {
    return { kind: "reauthorization-required", reason: "missing" };
  }
  const parsed = cvp3ProjectKeyGrantStateSchema.safeParse(candidate);
  if (!parsed.success) {
    return { kind: "reauthorization-required", reason: "malformed" };
  }
  const grant = parsed.data;
  if (
    grant.workspaceId !== expected.workspaceId
    || grant.projectId !== expected.projectId
    || grant.roomId !== expected.roomId
    || grant.deviceId !== expected.deviceId
  ) {
    return { kind: "reauthorization-required", reason: "binding-mismatch" };
  }
  if (grant.certificateId !== expected.certificateId) {
    return {
      kind: "reauthorization-required",
      reason: "certificate-mismatch",
    };
  }
  return { kind: "matched", grant };
}

function projectKeyGrantMatches(
  grant: ProjectKeyGrant,
  expected: ProjectKeyGrantBinding,
): boolean {
  return (
    grant.workspaceId === expected.workspaceId
    && grant.projectId === expected.projectId
    && grant.roomId === expected.roomId
    && grant.deviceId === expected.deviceId
    && grant.certificateId === expected.certificateId
  );
}

