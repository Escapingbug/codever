import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  loginWithMatrixPassword,
  loginWithMatrixToken,
  requestMatrixLoginToken,
} from "../app/matrixAuth.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("reauthenticates the current session before creating a one-time login token", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (requests.length === 1) {
      return jsonResponse(
        {
          session: "uia-session",
          flows: [{ stages: ["m.login.password"] }],
        },
        401,
      );
    }
    return jsonResponse({
      login_token: "login-once",
      expires_in_ms: 120_000,
    });
  };

  const result = await requestMatrixLoginToken(
    {
      homeserver: "https://matrix.example/",
      userId: "@alice:example",
      accessToken: "current-access-token",
    },
    "correct horse battery staple",
    1_800_000_000_000,
  );

  assert.deepEqual(result, {
    status: "ready",
    loginToken: "login-once",
    expiresAt: 1_800_000_120_000,
  });
  assert.equal(
    new Headers(requests[0]?.init?.headers).get("authorization"),
    "Bearer current-access-token",
  );
  const reauth = JSON.parse(String(requests[1]?.init?.body));
  assert.deepEqual(reauth.auth, {
    type: "m.login.password",
    identifier: { type: "m.id.user", user: "@alice:example" },
    password: "correct horse battery staple",
    session: "uia-session",
  });
});

test("reports unsupported get_token so the PWA can offer normal Matrix login", async () => {
  globalThis.fetch = async () =>
    jsonResponse({ errcode: "M_UNRECOGNIZED" }, 404);

  assert.deepEqual(
    await requestMatrixLoginToken({
      homeserver: "https://matrix.example",
      userId: "@alice:example",
      accessToken: "current-access-token",
    }),
    { status: "unsupported" },
  );
});

test("creates independent Matrix device sessions from token or password login", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return jsonResponse({
      user_id: "@alice:example",
      access_token: `device-access-token-${bodies.length}`,
      device_id: `PWA_${bodies.length}`,
    });
  };

  const tokenLogin = await loginWithMatrixToken(
    "https://matrix.example",
    "login-once",
    "@alice:example",
    "Codever phone",
  );
  const passwordLogin = await loginWithMatrixPassword(
    "https://matrix.example",
    "@alice:example",
    "matrix-password",
    "Codever laptop",
  );

  assert.equal(bodies[0]?.type, "m.login.token");
  assert.equal(bodies[1]?.type, "m.login.password");
  assert.deepEqual(tokenLogin, {
    homeserver: "https://matrix.example",
    userId: "@alice:example",
    accessToken: "device-access-token-1",
    matrixDeviceId: "PWA_1",
  });
  assert.equal(passwordLogin.matrixDeviceId, "PWA_2");
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
