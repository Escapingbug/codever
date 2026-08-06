import assert from "node:assert/strict";
import test from "node:test";
import { deriveComposerState } from "../app/composerState.ts";

const ready = {
  connectionStatus: "connected" as const,
  hasGatewayState: true,
  hasSelectedSession: true,
  selectedArchived: false,
  attachmentBusy: false,
  promptSubmitting: false,
  isStreaming: false,
  isStopping: false,
  hasContent: true,
};

test("allows a new message to be queued while the agent is running", () => {
  assert.deepEqual(
    deriveComposerState({ ...ready, isStreaming: true }),
    {
      canType: true,
      canSend: true,
      mode: "queue",
      reason: "Agent is working · Send queues this message",
    },
  );
});

test("blocks submission while the previous command is waiting for acknowledgement", () => {
  assert.deepEqual(
    deriveComposerState({ ...ready, promptSubmitting: true }),
    {
      canType: true,
      canSend: false,
      mode: "blocked",
      reason: "Sending the previous message…",
    },
  );
});

test("distinguishes reconnecting, stopping, syncing, archived, and empty states", () => {
  assert.equal(
    deriveComposerState({ ...ready, connectionStatus: "securing" }).reason,
    "Checking your approved computer…",
  );
  assert.equal(
    deriveComposerState({ ...ready, connectionStatus: "reconnecting" }).reason,
    "Reconnecting… Your draft will be kept.",
  );
  assert.equal(
    deriveComposerState({ ...ready, isStopping: true }).reason,
    "Waiting for the agent to stop…",
  );
  assert.equal(
    deriveComposerState({ ...ready, hasGatewayState: false }).reason,
    "Syncing your conversations…",
  );
  assert.equal(
    deriveComposerState({ ...ready, selectedArchived: true }).reason,
    "Restore this session to continue.",
  );
  assert.equal(
    deriveComposerState({ ...ready, hasContent: false }).reason,
    "Write a message or attach a file.",
  );
});

test("keeps the draft editable during reconnecting but not without a usable session", () => {
  assert.equal(
    deriveComposerState({ ...ready, connectionStatus: "securing" }).canType,
    true,
  );
  assert.equal(
    deriveComposerState({ ...ready, connectionStatus: "reconnecting" }).canType,
    true,
  );
  assert.equal(
    deriveComposerState({ ...ready, hasSelectedSession: false }).canType,
    false,
  );
  assert.equal(
    deriveComposerState({ ...ready, selectedArchived: true }).canType,
    false,
  );
});
