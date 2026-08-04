import type { MatrixConnectionConfig } from "./matrix";
import { normalizeHomeserver } from "./matrix";

const PASSWORD_LOGIN_TYPE = "m.login.password";
const TOKEN_LOGIN_TYPE = "m.login.token";
const DEFAULT_MATRIX_RATE_LIMIT_RETRY_MS = 60_000;

export class MatrixRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Matrix is temporarily limiting new-device sign-ins.");
    this.name = "MatrixRateLimitError";
  }
}

export type MatrixLoginCredentials = Pick<
  MatrixConnectionConfig,
  "homeserver" | "userId" | "accessToken" | "matrixDeviceId"
>;

export type MatrixLoginTokenResult =
  | {
      status: "ready";
      loginToken: string;
      expiresAt: number;
    }
  | {
      status: "reauth-required";
      passwordSupported: boolean;
    }
  | {
      status: "unsupported";
    };

export async function requestMatrixLoginToken(
  config: Pick<
    MatrixConnectionConfig,
    "homeserver" | "userId" | "accessToken"
  >,
  password?: string,
  now = Date.now(),
): Promise<MatrixLoginTokenResult> {
  const homeserver = normalizeHomeserver(config.homeserver);
  const accessToken = config.accessToken.trim();
  const userId = config.userId.trim();
  if (!accessToken || !userId) {
    throw new Error("The current Matrix session is not signed in.");
  }

  const initial = await postLoginToken(homeserver, accessToken, {});
  if (initial.response.ok) {
    return parseLoginToken(initial.body, now);
  }
  if (isUnsupportedLoginToken(initial.response.status, initial.body)) {
    return { status: "unsupported" };
  }
  if (initial.response.status !== 401) {
    throw matrixApiError(
      initial.response.status,
      initial.body,
      "The homeserver could not create a device login token.",
    );
  }

  const session =
    typeof initial.body?.session === "string" ? initial.body.session : "";
  const passwordSupported = supportsPasswordReauthentication(initial.body);
  if (!password) {
    return { status: "reauth-required", passwordSupported };
  }
  if (!session || !passwordSupported) {
    throw new Error(
      "This homeserver requires a reauthentication method the PWA does not yet support.",
    );
  }

  const completed = await postLoginToken(homeserver, accessToken, {
    auth: {
      type: PASSWORD_LOGIN_TYPE,
      identifier: { type: "m.id.user", user: userId },
      password,
      session,
    },
  });
  if (!completed.response.ok) {
    throw matrixApiError(
      completed.response.status,
      completed.body,
      "Matrix reauthentication was not accepted.",
    );
  }
  return parseLoginToken(completed.body, now);
}

export async function loginWithMatrixToken(
  homeserverInput: string,
  loginToken: string,
  expectedUserId: string,
  deviceName: string,
): Promise<MatrixLoginCredentials> {
  return login(
    homeserverInput,
    {
      type: TOKEN_LOGIN_TYPE,
      token: requireText(loginToken, "Matrix login token"),
      initial_device_display_name: requireText(deviceName, "Device name"),
    },
    expectedUserId,
  );
}

export async function loginWithMatrixPassword(
  homeserverInput: string,
  userId: string,
  password: string,
  deviceName: string,
): Promise<MatrixLoginCredentials> {
  const normalizedUserId = requireText(userId, "Matrix ID");
  return login(
    homeserverInput,
    {
      type: PASSWORD_LOGIN_TYPE,
      identifier: { type: "m.id.user", user: normalizedUserId },
      password: requireText(password, "Matrix password"),
      initial_device_display_name: requireText(deviceName, "Device name"),
    },
    normalizedUserId,
  );
}

async function login(
  homeserverInput: string,
  body: Record<string, unknown>,
  expectedUserId: string,
): Promise<MatrixLoginCredentials> {
  const homeserver = normalizeHomeserver(homeserverInput);
  const response = await fetch(`${homeserver}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await readJson(response);
  if (!response.ok) {
    throw matrixApiError(
      response.status,
      result,
      "Matrix sign-in was not accepted.",
    );
  }
  const accessToken =
    typeof result?.access_token === "string" ? result.access_token : "";
  const userId = typeof result?.user_id === "string" ? result.user_id : "";
  const matrixDeviceId =
    typeof result?.device_id === "string" ? result.device_id : "";
  if (!accessToken || !userId || !matrixDeviceId) {
    throw new Error("Matrix did not return a complete device session.");
  }
  if (expectedUserId && expectedUserId !== userId) {
    throw new Error("The Matrix login belongs to a different account.");
  }
  return { homeserver, userId, accessToken, matrixDeviceId };
}

async function postLoginToken(
  homeserver: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<{
  response: Response;
  body: Record<string, unknown> | null;
}> {
  const response = await fetch(
    `${homeserver}/_matrix/client/v1/login/get_token`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  return { response, body: await readJson(response) };
}

function parseLoginToken(
  body: Record<string, unknown> | null,
  now: number,
): Extract<MatrixLoginTokenResult, { status: "ready" }> {
  const loginToken =
    typeof body?.login_token === "string" ? body.login_token : "";
  const expiresInMs =
    typeof body?.expires_in_ms === "number" &&
    Number.isSafeInteger(body.expires_in_ms) &&
    body.expires_in_ms > 0
      ? body.expires_in_ms
      : 2 * 60_000;
  if (!loginToken) {
    throw new Error("Matrix did not return a device login token.");
  }
  return {
    status: "ready",
    loginToken,
    expiresAt: now + expiresInMs,
  };
}

function supportsPasswordReauthentication(
  body: Record<string, unknown> | null,
): boolean {
  if (!Array.isArray(body?.flows)) return false;
  return body.flows.some((flow) => {
    if (!flow || typeof flow !== "object") return false;
    const stages = (flow as Record<string, unknown>).stages;
    return Array.isArray(stages) && stages.includes(PASSWORD_LOGIN_TYPE);
  });
}

function isUnsupportedLoginToken(
  status: number,
  body: Record<string, unknown> | null,
): boolean {
  return (
    status === 404 ||
    status === 405 ||
    body?.errcode === "M_UNRECOGNIZED"
  );
}

async function readJson(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const value = (await response.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function matrixApiError(
  status: number,
  body: Record<string, unknown> | null,
  fallback: string,
): Error {
  if (status === 429 || body?.errcode === "M_LIMIT_EXCEEDED") {
    const retryAfterMs =
      typeof body?.retry_after_ms === "number" &&
      Number.isSafeInteger(body.retry_after_ms) &&
      body.retry_after_ms > 0
        ? body.retry_after_ms
        : DEFAULT_MATRIX_RATE_LIMIT_RETRY_MS;
    return new MatrixRateLimitError(retryAfterMs);
  }
  return new Error(
    typeof body?.error === "string" && body.error.trim()
      ? body.error
      : fallback,
  );
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}
