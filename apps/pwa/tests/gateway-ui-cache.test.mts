import assert from "node:assert/strict";
import test from "node:test";
import {
  clearGatewayUiCache,
  GATEWAY_UI_CACHE_STORAGE_KEY,
  readGatewayUiCache,
  writeGatewayUiCache,
} from "../app/gatewayUiCache.ts";
import type { GatewayStateSnapshot } from "../app/gatewayState.ts";
import type { MatrixConnectionConfig } from "../app/matrix.ts";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const config: MatrixConnectionConfig = {
  homeserver: "https://matrix.example",
  userId: "@device:example",
  accessToken: "secret",
  matrixDeviceId: "MOBILE",
  roomId: "!room:example",
  gatewayId: "gateway-1",
  conversationId: "conversation-1",
  gatewayMatrixUserId: "@gateway:example",
  gatewayMatrixDeviceId: "GATEWAY",
  gatewayMatrixEd25519: "key",
};

const snapshot: GatewayStateSnapshot = {
  stateVersion: 3,
  revision: 7,
  revisionEpoch: "epoch-1",
  revisionEpochGeneration: 1,
  activeDeviceCount: 2,
  updatedAt: 1_900_000_000_000,
  currentSessionId: "session-1",
  sessions: [{
    id: "session-1",
    title: "Background task",
    updatedAt: 1_900_000_000_000,
    status: "running",
    activityPhase: "working",
    scope: "project",
    projectId: "project-1",
    projectName: "Codever",
    cwd: "/workspace/codever",
    provider: "agent",
    activeTurnId: "turn-1",
    extensions: [],
    availableCommands: [],
  }],
  workspace: {
    projectId: "project-1",
    projectName: "Codever",
    cwd: "/workspace/codever",
    provider: "agent",
    permissionMode: "default",
  },
  capabilities: {
    models: [],
    providers: [],
    permissionModes: [],
    canCreateSession: true,
    canSelectSession: true,
    sessionExtensions: [],
  },
};

test("restores only the display projection bound to the current Gateway room", () => {
  const storage = new MemoryStorage();
  writeGatewayUiCache(storage, config, snapshot);

  assert.deepEqual(readGatewayUiCache(storage, config), snapshot);
  assert.equal(
    readGatewayUiCache(storage, { ...config, roomId: "!other:example" }),
    null,
  );
});

test("ignores malformed projection data and supports explicit forgetting", () => {
  const storage = new MemoryStorage();
  storage.setItem(GATEWAY_UI_CACHE_STORAGE_KEY, "{not-json");
  assert.equal(readGatewayUiCache(storage, config), null);

  writeGatewayUiCache(storage, config, snapshot);
  clearGatewayUiCache(storage);
  assert.equal(storage.getItem(GATEWAY_UI_CACHE_STORAGE_KEY), null);
});
