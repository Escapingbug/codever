import { describe, expect, it } from "vitest";
import {
  reconcileOptimisticSessionDeletions,
  setSessionOptimisticallyDeleted,
} from "./optimisticSessionDeletion";

describe("optimistic session deletion", () => {
  it("hides immediately and can roll back without mutating prior state", () => {
    const initial = new Set(["other"]);
    const hidden = setSessionOptimisticallyDeleted(initial, "target", true);
    const restored = setSessionOptimisticallyDeleted(hidden, "target", false);

    expect([...initial]).toEqual(["other"]);
    expect([...hidden]).toEqual(["other", "target"]);
    expect([...restored]).toEqual(["other"]);
  });

  it("drops the marker only after authoritative deletion converges", () => {
    const pending = new Set(["target"]);
    expect([
      ...reconcileOptimisticSessionDeletions(
        pending,
        new Set(["target", "other"]),
      ),
    ]).toEqual(["target"]);
    expect([
      ...reconcileOptimisticSessionDeletions(pending, new Set(["other"])),
    ]).toEqual([]);
  });
});
