export const INVITATION_RELAY_MAX_ENTRIES = 256;
export const INVITATION_RELAY_MAX_LIFETIME_MS = 10 * 60_000;
export const INVITATION_RELAY_MAX_CIPHERTEXT_CHARS = 32_768;

const invitationIdPattern = /^[A-Za-z0-9_-]{22}$/u;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

export type EncryptedInvitationRelayEntry = {
  ciphertext: string;
  iv: string;
  expiresAt: number;
};

type StoreResult =
  | { status: "stored" }
  | { status: "duplicate" }
  | { status: "full" }
  | { status: "invalid" };

const invitations = new Map<string, EncryptedInvitationRelayEntry>();

export function storeEncryptedInvitation(
  id: string,
  entry: EncryptedInvitationRelayEntry,
  now = Date.now(),
): StoreResult {
  pruneExpiredInvitations(now);
  if (!validInvitationId(id) || !validEntry(entry, now)) {
    return { status: "invalid" };
  }
  if (invitations.has(id)) return { status: "duplicate" };
  if (invitations.size >= INVITATION_RELAY_MAX_ENTRIES) {
    return { status: "full" };
  }
  invitations.set(id, { ...entry });
  return { status: "stored" };
}

export function resolveEncryptedInvitation(
  id: string,
  now = Date.now(),
): EncryptedInvitationRelayEntry | null {
  pruneExpiredInvitations(now);
  if (!validInvitationId(id)) return null;
  const entry = invitations.get(id);
  return entry ? { ...entry } : null;
}

export function clearInvitationRelayForTests(): void {
  invitations.clear();
}

function pruneExpiredInvitations(now: number): void {
  for (const [id, entry] of invitations) {
    if (entry.expiresAt <= now) invitations.delete(id);
  }
}

function validInvitationId(value: string): boolean {
  return invitationIdPattern.test(value);
}

function validEntry(
  entry: EncryptedInvitationRelayEntry,
  now: number,
): boolean {
  return (
    typeof entry.ciphertext === "string" &&
    entry.ciphertext.length >= 22 &&
    entry.ciphertext.length <= INVITATION_RELAY_MAX_CIPHERTEXT_CHARS &&
    base64UrlPattern.test(entry.ciphertext) &&
    typeof entry.iv === "string" &&
    entry.iv.length === 16 &&
    base64UrlPattern.test(entry.iv) &&
    Number.isSafeInteger(entry.expiresAt) &&
    entry.expiresAt > now &&
    entry.expiresAt <= now + INVITATION_RELAY_MAX_LIFETIME_MS
  );
}
