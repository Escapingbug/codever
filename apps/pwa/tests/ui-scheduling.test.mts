import assert from "node:assert/strict";
import test from "node:test";
import { waitForUiCommit, type UiScheduler } from "../app/uiScheduling.ts";

test("continues business work when a background WebView never receives an animation frame", async () => {
  let timerCallback: (() => void) | undefined;
  let cancelledFrame = false;
  const scheduler: UiScheduler = {
    requestFrame: () => 7,
    cancelFrame(handle) {
      assert.equal(handle, 7);
      cancelledFrame = true;
    },
    setTimer(callback) {
      timerCallback = callback;
      return 8;
    },
    clearTimer(handle) {
      assert.equal(handle, 8);
    },
  };
  const waiting = waitForUiCommit(scheduler);
  assert.ok(timerCallback);
  timerCallback();
  await waiting;
  assert.equal(cancelledFrame, true);
});

test("uses the next frame immediately when the WebView is visible", async () => {
  let frameCallback: (() => void) | undefined;
  let clearedTimer = false;
  const scheduler: UiScheduler = {
    requestFrame(callback) {
      frameCallback = callback;
      return 9;
    },
    cancelFrame(handle) {
      assert.equal(handle, 9);
    },
    setTimer() {
      return 10;
    },
    clearTimer(handle) {
      assert.equal(handle, 10);
      clearedTimer = true;
    },
  };
  const waiting = waitForUiCommit(scheduler);
  assert.ok(frameCallback);
  frameCallback();
  await waiting;
  assert.equal(clearedTimer, true);
});
