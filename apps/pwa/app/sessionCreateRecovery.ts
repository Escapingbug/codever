import type { NewSessionInput } from "./NewSessionDialog";

const PENDING_SESSION_CREATE_KEY = "codever:pending-session-create:v1";

type SessionCreateRecoveryStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export type PendingSessionCreateRecovery = {
  version: 1;
  commandId: string;
  gatewayId: string;
  conversationId: string;
  createdAt: number;
  input: NewSessionInput;
};

export function readPendingSessionCreateRecovery(
  storage: SessionCreateRecoveryStorage | null,
): PendingSessionCreateRecovery | null {
  if (!storage) return null;
  try {
    const encoded = storage.getItem(PENDING_SESSION_CREATE_KEY);
    if (!encoded) return null;
    return parsePendingSessionCreateRecovery(JSON.parse(encoded));
  } catch {
    return null;
  }
}

export function writePendingSessionCreateRecovery(
  storage: SessionCreateRecoveryStorage,
  recovery: PendingSessionCreateRecovery,
): void {
  storage.setItem(PENDING_SESSION_CREATE_KEY, JSON.stringify(recovery));
}

export function clearPendingSessionCreateRecovery(
  storage: SessionCreateRecoveryStorage,
  expectedCommandId?: string,
): boolean {
  if (expectedCommandId) {
    const current = readPendingSessionCreateRecovery(storage);
    if (current?.commandId !== expectedCommandId) return false;
  }
  storage.removeItem(PENDING_SESSION_CREATE_KEY);
  return true;
}

export function sessionCreateRecoveryMatches(
  recovery: PendingSessionCreateRecovery,
  binding: { gatewayId: string; conversationId: string },
): boolean {
  return (
    recovery.gatewayId === binding.gatewayId &&
    recovery.conversationId === binding.conversationId
  );
}

function parsePendingSessionCreateRecovery(
  value: unknown,
): PendingSessionCreateRecovery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const input = record.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const sessionInput = input as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !isNonEmptyString(record.commandId) ||
    !isNonEmptyString(record.gatewayId) ||
    !isNonEmptyString(record.conversationId) ||
    typeof record.createdAt !== "number" ||
    !Number.isFinite(record.createdAt) ||
    !isNonEmptyString(sessionInput.cwd) ||
    !isNonEmptyString(sessionInput.projectName) ||
    !isOptionalString(sessionInput.model) ||
    !isOptionalString(sessionInput.reasoningEffort) ||
    !isOptionalArray(sessionInput.extensions)
  ) {
    return null;
  }
  return value as PendingSessionCreateRecovery;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalArray(value: unknown): value is unknown[] | undefined {
  return value === undefined || Array.isArray(value);
}
