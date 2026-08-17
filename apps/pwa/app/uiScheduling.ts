export type UiScheduler = {
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(handle: number): void;
};

const browserScheduler: UiScheduler = {
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (handle) => window.cancelAnimationFrame(handle),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (handle) => window.clearTimeout(handle),
};

/**
 * Gives React a rendering opportunity without making business execution depend
 * on a visible document. Android suspends animation frames while the WebView is
 * backgrounded, but its foreground service must still be able to submit work.
 */
export function waitForUiCommit(
  scheduler: UiScheduler = browserScheduler,
  fallbackMs = 100,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let frame = 0;
    let timer = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      scheduler.cancelFrame(frame);
      scheduler.clearTimer(timer);
      resolve();
    };
    frame = scheduler.requestFrame(finish);
    timer = scheduler.setTimer(finish, fallbackMs);
  });
}
