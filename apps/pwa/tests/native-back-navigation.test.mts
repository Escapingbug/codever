import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeBackDispatcher,
  resolveCodeverBackAction,
} from "../app/nativeBackNavigation.ts";

const emptyState = {
  deleteDialogOpen: false,
  deleteDialogBusy: false,
  newSessionOpen: false,
  newSessionBusy: false,
  settingsOpen: false,
  detailsOpen: false,
  mobileChatOpen: false,
};

test("selects the topmost visible Codever UI layer", () => {
  assert.equal(
    resolveCodeverBackAction({
      ...emptyState,
      deleteDialogOpen: true,
      settingsOpen: true,
      mobileChatOpen: true,
    }),
    "close-delete-dialog",
  );
  assert.equal(
    resolveCodeverBackAction({
      ...emptyState,
      newSessionOpen: true,
      settingsOpen: true,
      mobileChatOpen: true,
    }),
    "close-new-session",
  );
  assert.equal(
    resolveCodeverBackAction({
      ...emptyState,
      settingsOpen: true,
      detailsOpen: true,
      mobileChatOpen: true,
    }),
    "close-settings",
  );
  assert.equal(
    resolveCodeverBackAction({
      ...emptyState,
      detailsOpen: true,
      mobileChatOpen: true,
    }),
    "close-details",
  );
  assert.equal(
    resolveCodeverBackAction({ ...emptyState, mobileChatOpen: true }),
    "show-conversations",
  );
  assert.equal(resolveCodeverBackAction(emptyState), null);
});

test("consumes Back without closing destructive or create dialogs while busy", () => {
  assert.equal(
    resolveCodeverBackAction({
      ...emptyState,
      deleteDialogOpen: true,
      deleteDialogBusy: true,
    }),
    "block-delete-dialog",
  );
  assert.equal(
    resolveCodeverBackAction({
      ...emptyState,
      newSessionOpen: true,
      newSessionBusy: true,
    }),
    "block-new-session",
  );
});

test("dispatches to the highest priority active handler and stops", () => {
  const dispatcher = new NativeBackDispatcher();
  const calls: string[] = [];
  dispatcher.register(() => {
    calls.push("app");
    return true;
  });
  const unregisterNested = dispatcher.register(() => {
    calls.push("scanner");
    return true;
  }, 100);

  assert.equal(dispatcher.dispatch(), true);
  assert.deepEqual(calls, ["scanner"]);

  unregisterNested();
  assert.equal(dispatcher.dispatch(), true);
  assert.deepEqual(calls, ["scanner", "app"]);
});

test("continues past handlers that decline Back", () => {
  const dispatcher = new NativeBackDispatcher();
  const calls: string[] = [];
  dispatcher.register(() => {
    calls.push("fallback");
    return true;
  });
  dispatcher.register(() => {
    calls.push("declined");
    return false;
  }, 100);

  assert.equal(dispatcher.dispatch(), true);
  assert.deepEqual(calls, ["declined", "fallback"]);
});
