import {
  resolveEncryptedInvitation,
  storeEncryptedInvitation,
} from "./relayStore";

const MAX_REQUEST_BYTES = 48 * 1024;
const responseHeaders = {
  "cache-control": "no-store, max-age=0",
  "content-type": "application/json; charset=utf-8",
};

export async function POST(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: "Invitation request is too large." }, 413);
  }

  let input: unknown;
  try {
    const text = await readLimitedRequestText(request);
    if (text === null) {
      return jsonResponse({ error: "Invitation request is too large." }, 413);
    }
    input = JSON.parse(text);
  } catch {
    return jsonResponse({ error: "Invitation request is not valid JSON." }, 400);
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return jsonResponse({ error: "Invitation request is invalid." }, 400);
  }
  const body = input as Record<string, unknown>;

  if (body.action === "store") {
    if (
      typeof body.id !== "string" ||
      typeof body.ciphertext !== "string" ||
      typeof body.iv !== "string" ||
      typeof body.expiresAt !== "number"
    ) {
      return jsonResponse({ error: "Encrypted invitation is invalid." }, 400);
    }
    const result = storeEncryptedInvitation(body.id, {
      ciphertext: body.ciphertext,
      iv: body.iv,
      expiresAt: body.expiresAt,
    });
    switch (result.status) {
      case "stored":
        return jsonResponse({ stored: true }, 201);
      case "duplicate":
        return jsonResponse({ error: "Invitation ID already exists." }, 409);
      case "full":
        return jsonResponse(
          { error: "The invitation relay is temporarily full." },
          503,
        );
      case "invalid":
        return jsonResponse({ error: "Encrypted invitation is invalid." }, 400);
    }
  }

  if (body.action === "resolve") {
    if (typeof body.id !== "string") {
      return jsonResponse({ error: "Invitation ID is invalid." }, 400);
    }
    const entry = resolveEncryptedInvitation(body.id);
    if (!entry) {
      return jsonResponse(
        { error: "This invitation is unavailable or expired." },
        404,
      );
    }
    return jsonResponse(entry, 200);
  }

  return jsonResponse({ error: "Invitation action is unsupported." }, 400);
}

async function readLimitedRequestText(
  request: Request,
): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}
