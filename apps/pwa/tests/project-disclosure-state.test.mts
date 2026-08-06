import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_DISCLOSURE_STORAGE_KEY,
  isProjectExpanded,
  projectDisclosureKey,
  readProjectDisclosureState,
  setProjectCollapsed,
  toggleProjectCollapsed,
  writeProjectDisclosureState,
} from "../app/projectDisclosureState.ts";

test("uses a stable Gateway/project identity and immutable disclosure updates", () => {
  const key = projectDisclosureKey("gateway-a", "project-a");
  assert.equal(key, "gateway-a\u0000project-a");

  const initial = new Set<string>();
  const collapsed = setProjectCollapsed(initial, key, true);
  assert.equal(initial.has(key), false);
  assert.equal(collapsed.has(key), true);
  assert.equal(toggleProjectCollapsed(collapsed, key).has(key), false);
});

test("search temporarily expands a project while manual collapse stays usable", () => {
  const projectKey = projectDisclosureKey("gateway-a", "project-a");
  const state = new Set([projectKey]);
  const input = {
    state,
    projectKey,
  };

  assert.equal(isProjectExpanded(input), false);
  assert.equal(isProjectExpanded({ ...input, searchQuery: " matrix " }), true);
  const explicitlyExpanded = setProjectCollapsed(state, projectKey, false);
  assert.equal(
    isProjectExpanded({ state: explicitlyExpanded, projectKey }),
    true,
  );
  assert.equal(state.has(projectKey), true, "search does not mutate persistence");
});

test("localStorage persistence is deterministic and safely rejects bad data", () => {
  let stored: string | null = null;
  const storage = {
    getItem(key: string) {
      assert.equal(key, PROJECT_DISCLOSURE_STORAGE_KEY);
      return stored;
    },
    setItem(key: string, value: string) {
      assert.equal(key, PROJECT_DISCLOSURE_STORAGE_KEY);
      stored = value;
    },
  };

  assert.equal(
    writeProjectDisclosureState(storage, new Set(["z", "a"])),
    true,
  );
  assert.equal(stored, '{"version":1,"collapsed":["a","z"]}');
  assert.deepEqual([...readProjectDisclosureState(storage)], ["a", "z"]);

  stored = '{"version":2,"collapsed":["a"]}';
  assert.deepEqual([...readProjectDisclosureState(storage)], []);
  stored = "not json";
  assert.deepEqual([...readProjectDisclosureState(storage)], []);
});

test("storage security and quota failures never escape into the UI", () => {
  const blockedRead = {
    getItem(): string | null {
      throw new DOMException("blocked", "SecurityError");
    },
  };
  const blockedWrite = {
    setItem(): void {
      throw new DOMException("full", "QuotaExceededError");
    },
  };

  assert.deepEqual([...readProjectDisclosureState(blockedRead)], []);
  assert.equal(writeProjectDisclosureState(blockedWrite, new Set(["x"])), false);
  assert.equal(writeProjectDisclosureState(undefined, new Set(["x"])), false);
});
