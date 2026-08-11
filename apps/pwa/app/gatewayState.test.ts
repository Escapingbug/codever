import { describe, expect, it } from "vitest";
import {
  classifyGatewayStateProgress,
  isIgnorableGatewayStateReplay,
} from "./gatewayState";

describe("Gateway state progress", () => {
  it("accepts a Matrix-native revision advance on the current checkpoint", () => {
    expect(
      classifyGatewayStateProgress(
        { stateVersion: 1, revision: 0 },
        { stateVersion: 1, revision: 1 },
      ),
    ).toBe("advance");
  });

  it("accepts checkpoint and revision advances independently", () => {
    expect(
      classifyGatewayStateProgress(
        { stateVersion: 1, revision: 1 },
        { stateVersion: 2, revision: 1 },
      ),
    ).toBe("advance");
  });

  it("rejects a regression in either monotonic dimension", () => {
    expect(
      classifyGatewayStateProgress(
        { stateVersion: 2, revision: 3 },
        { stateVersion: 1, revision: 4 },
      ),
    ).toBe("stale");
    expect(
      classifyGatewayStateProgress(
        { stateVersion: 2, revision: 3 },
        { stateVersion: 3, revision: 2 },
      ),
    ).toBe("stale");
  });

  it("ignores authenticated older timeline state without accepting conflicts", () => {
    expect(isIgnorableGatewayStateReplay("retired")).toBe(true);
    expect(isIgnorableGatewayStateReplay("stale")).toBe(true);
    expect(isIgnorableGatewayStateReplay("current", "stale")).toBe(true);
    expect(isIgnorableGatewayStateReplay("conflict")).toBe(false);
    expect(isIgnorableGatewayStateReplay("current", "advance")).toBe(false);
  });
});
