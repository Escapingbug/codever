import assert from "node:assert/strict";
import test from "node:test";
import { MatrixLoginTokenLifecycle } from "../app/matrixLoginTokenLifecycle.ts";
import { MatrixRateLimitError } from "../app/matrixAuth.ts";

test("reuses an issued login token while the same invitation is being relayed", async () => {
  const now = 1_800_000_000_000;
  const lifecycle = new MatrixLoginTokenLifecycle({ now: () => now });
  let issues = 0;
  const request = {
    invitationId: "gateway-command-1",
    invitationExpiresAt: now + 5 * 60_000,
    issue: async () => {
      issues += 1;
      return {
        status: "ready" as const,
        loginToken: "login-once",
        expiresAt: now + 2 * 60_000,
      };
    },
  };

  const first = await lifecycle.request(request);
  const afterRelayRetry = await lifecycle.request(request);

  assert.deepEqual(afterRelayRetry, first);
  assert.equal(issues, 1);
});

test("waits for the declared Matrix limit and retries the same invitation", async () => {
  let now = 1_800_000_000_000;
  const sleeps: number[] = [];
  const countdown: number[] = [];
  let issues = 0;
  const lifecycle = new MatrixLoginTokenLifecycle({
    now: () => now,
    sleep: async (durationMs) => {
      sleeps.push(durationMs);
      now += durationMs;
    },
  });

  const result = await lifecycle.request({
    invitationId: "gateway-command-1",
    invitationExpiresAt: now + 5 * 60_000,
    issue: async () => {
      issues += 1;
      if (issues === 1) throw new MatrixRateLimitError(2_500);
      return {
        status: "ready",
        loginToken: "login-after-wait",
        expiresAt: now + 2 * 60_000,
      };
    },
    onRateLimit: (remainingMs) => countdown.push(remainingMs),
  });

  assert.equal(result.status, "ready");
  assert.equal(issues, 2);
  assert.deepEqual(sleeps, [1_000, 1_000, 500]);
  assert.deepEqual(countdown, [2_500, 1_500, 500, 0]);
});

test("coalesces duplicate token requests for one invitation", async () => {
  const now = 1_800_000_000_000;
  const lifecycle = new MatrixLoginTokenLifecycle({ now: () => now });
  let issues = 0;
  let finish!: (result: {
    status: "ready";
    loginToken: string;
    expiresAt: number;
  }) => void;
  const input = {
    invitationId: "gateway-command-1",
    invitationExpiresAt: now + 5 * 60_000,
    issue: () => {
      issues += 1;
      return new Promise<{
        status: "ready";
        loginToken: string;
        expiresAt: number;
      }>((resolve) => {
        finish = resolve;
      });
    },
  };

  const first = lifecycle.request(input);
  const duplicate = lifecycle.request(input);

  assert.equal(first, duplicate);
  assert.equal(issues, 1);
  finish({
    status: "ready",
    loginToken: "login-once",
    expiresAt: now + 2 * 60_000,
  });
  assert.deepEqual(await first, await duplicate);
});

test("does not wait past the useful lifetime of the Gateway invitation", async () => {
  const now = 1_800_000_000_000;
  let slept = false;
  const lifecycle = new MatrixLoginTokenLifecycle({
    now: () => now,
    sleep: async () => {
      slept = true;
    },
  });

  await assert.rejects(
    lifecycle.request({
      invitationId: "gateway-command-1",
      invitationExpiresAt: now + 70_000,
      issue: async () => {
        throw new MatrixRateLimitError(60_000);
      },
    }),
    /wait longer than this invitation remains valid/,
  );
  assert.equal(slept, false);
});

test("clearing the transaction invalidates an in-flight token", async () => {
  const now = 1_800_000_000_000;
  const lifecycle = new MatrixLoginTokenLifecycle({ now: () => now });
  let finish!: (result: {
    status: "ready";
    loginToken: string;
    expiresAt: number;
  }) => void;
  const pending = lifecycle.request({
    invitationId: "gateway-command-1",
    invitationExpiresAt: now + 5 * 60_000,
    issue: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });

  lifecycle.clear();
  finish({
    status: "ready",
    loginToken: "stale-token",
    expiresAt: now + 2 * 60_000,
  });

  await assert.rejects(pending, /login-token request was cleared/);
});
