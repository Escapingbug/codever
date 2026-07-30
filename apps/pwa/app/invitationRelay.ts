import {
  decodeDeviceInvitationLink,
  type GeneratedDeviceInvitation,
} from "@codever/protocol";

const INVITATION_RELAY_PATH = "/api/invitations";
const INVITATION_ID_BYTES = 16;
const INVITATION_KEY_BYTES = 32;
const INVITATION_IV_BYTES = 12;
const invitationIdPattern = /^[A-Za-z0-9_-]{22}$/u;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

export type InvitationRelayClient = {
  crypto: Crypto;
  fetch: typeof fetch;
};

export async function shortenDeviceInvitation(
  invitation: GeneratedDeviceInvitation,
  appUrl: string,
  client: InvitationRelayClient = browserRelayClient(),
): Promise<GeneratedDeviceInvitation> {
  const url = normalizedHttpUrl(appUrl);
  const keyBytes = randomBytes(client.crypto, INVITATION_KEY_BYTES);
  const key = await importInvitationKey(client.crypto, keyBytes, [
    "encrypt",
  ]);
  const plaintext = new TextEncoder().encode(invitation.link);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const id = encodeBase64Url(
      randomBytes(client.crypto, INVITATION_ID_BYTES),
    );
    const iv = randomBytes(client.crypto, INVITATION_IV_BYTES);
    const ciphertext = new Uint8Array(
      await client.crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: ownedArrayBuffer(iv),
          additionalData: ownedArrayBuffer(
            invitationAdditionalData(
              url.origin,
              id,
              invitation.expiresAt,
            ),
          ),
        },
        key,
        ownedArrayBuffer(plaintext),
      ),
    );
    const response = await client.fetch(
      new URL(INVITATION_RELAY_PATH, url.origin),
      {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "store",
          id,
          ciphertext: encodeBase64Url(ciphertext),
          iv: encodeBase64Url(iv),
          expiresAt: invitation.expiresAt,
        }),
      },
    );
    if (response.status === 409 && attempt === 0) continue;
    if (!response.ok) {
      throw new Error(await relayError(response, "store"));
    }

    url.hash = new URLSearchParams({
      i: id,
      k: encodeBase64Url(keyBytes),
    }).toString();
    return { ...invitation, link: url.toString() };
  }

  throw new Error("The invitation relay could not allocate a unique ID.");
}

export function hasShortDeviceInvitation(
  input: string,
  baseUrl: string,
): boolean {
  try {
    const url = new URL(input, baseUrl);
    const hash = new URLSearchParams(url.hash.replace(/^#/u, ""));
    return hash.has("i") || hash.has("k");
  } catch {
    return false;
  }
}

export async function resolveShortDeviceInvitation(
  input: string,
  baseUrl: string,
  client: InvitationRelayClient = browserRelayClient(),
): Promise<string> {
  const currentUrl = normalizedHttpUrl(baseUrl);
  const url = httpUrl(new URL(input, currentUrl).toString());
  if (url.origin !== currentUrl.origin) {
    throw new Error(
      "Open this invitation on the Codever site that created it.",
    );
  }
  const hash = new URLSearchParams(url.hash.replace(/^#/u, ""));
  const id = hash.get("i") ?? "";
  const encodedKey = hash.get("k") ?? "";
  if (!invitationIdPattern.test(id)) {
    throw new Error("This Codever invitation has an invalid short ID.");
  }
  const keyBytes = decodeBase64Url(encodedKey);
  if (keyBytes.length !== INVITATION_KEY_BYTES) {
    throw new Error("This Codever invitation has an invalid decryption key.");
  }

  const response = await client.fetch(
    new URL(INVITATION_RELAY_PATH, url.origin),
    {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "resolve", id }),
    },
  );
  if (!response.ok) {
    throw new Error(await relayError(response, "resolve"));
  }
  const entry = await readEncryptedEntry(response);
  if (entry.expiresAt <= Date.now()) {
    throw new Error("This Codever invitation expired.");
  }

  try {
    const key = await importInvitationKey(client.crypto, keyBytes, [
      "decrypt",
    ]);
    const plaintext = await client.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedArrayBuffer(
          decodeFixedBase64Url(entry.iv, INVITATION_IV_BYTES),
        ),
        additionalData: ownedArrayBuffer(
          invitationAdditionalData(url.origin, id, entry.expiresAt),
        ),
      },
      key,
      ownedArrayBuffer(decodeBase64Url(entry.ciphertext)),
    );
    const invitationLink = new TextDecoder("utf-8", { fatal: true }).decode(
      plaintext,
    );
    const invitation = decodeDeviceInvitationLink(
      invitationLink,
      url.toString(),
    );
    const expiresAt = Math.min(
      invitation.offer.offer.expiresAt,
      invitation.matrixLogin?.expiresAt ?? Number.POSITIVE_INFINITY,
    );
    if (expiresAt !== entry.expiresAt) {
      throw new Error("The encrypted invitation expiry does not match.");
    }
    return invitationLink;
  } catch (error) {
    throw new Error("This Codever invitation could not be decrypted.", {
      cause: error,
    });
  }
}

function browserRelayClient(): InvitationRelayClient {
  if (typeof window === "undefined") {
    throw new Error("The invitation relay is available only in a browser.");
  }
  return { crypto: window.crypto, fetch: window.fetch.bind(window) };
}

function normalizedHttpUrl(input: string): URL {
  const url = httpUrl(input);
  url.search = "";
  url.hash = "";
  return url;
}

function httpUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Codever invitation links must use HTTP or HTTPS.");
  }
  return url;
}

function randomBytes(crypto: Crypto, length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function importInvitationKey(
  crypto: Crypto,
  bytes: Uint8Array,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(bytes),
    { name: "AES-GCM" },
    false,
    usages,
  );
}

function invitationAdditionalData(
  origin: string,
  id: string,
  expiresAt: number,
): Uint8Array {
  return new TextEncoder().encode(
    `codever.invitation.relay.v1\u0000${origin}\u0000${id}\u0000${expiresAt}`,
  );
}

function ownedArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy.buffer;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!base64UrlPattern.test(value)) {
    throw new Error("Invalid base64url value.");
  }
  const padded =
    value.replace(/-/gu, "+").replace(/_/gu, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeFixedBase64Url(value: string, length: number): Uint8Array {
  const decoded = decodeBase64Url(value);
  if (decoded.length !== length) {
    throw new Error("Encrypted invitation metadata is invalid.");
  }
  return decoded;
}

async function relayError(
  response: Response,
  action: "store" | "resolve",
): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Use the stable fallback below when the server did not return JSON.
  }
  return action === "store"
    ? "The encrypted invitation could not be stored."
    : "This invitation is unavailable or expired.";
}

async function readEncryptedEntry(response: Response): Promise<{
  ciphertext: string;
  iv: string;
  expiresAt: number;
}> {
  const input = (await response.json()) as Record<string, unknown>;
  if (
    typeof input.ciphertext !== "string" ||
    input.ciphertext.length < 22 ||
    input.ciphertext.length > 32_768 ||
    !base64UrlPattern.test(input.ciphertext) ||
    typeof input.iv !== "string" ||
    typeof input.expiresAt !== "number" ||
    !Number.isSafeInteger(input.expiresAt)
  ) {
    throw new Error("The invitation relay returned invalid encrypted data.");
  }
  return {
    ciphertext: input.ciphertext,
    iv: input.iv,
    expiresAt: input.expiresAt,
  };
}
