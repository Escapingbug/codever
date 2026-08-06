import assert from "node:assert/strict";
import test from "node:test";
import { resolveFocusTrapTarget } from "../app/dialogFocus.ts";

test("wraps forward focus from the last dialog control", () => {
  const controls = ["first", "middle", "last"];
  assert.equal(resolveFocusTrapTarget(controls, "last", false), "first");
});

test("wraps backward focus from the first dialog control", () => {
  const controls = ["first", "middle", "last"];
  assert.equal(resolveFocusTrapTarget(controls, "first", true), "last");
});

test("moves outside focus into the dialog in the requested direction", () => {
  const controls = ["first", "last"];
  assert.equal(resolveFocusTrapTarget(controls, "outside", false), "first");
  assert.equal(resolveFocusTrapTarget(controls, "outside", true), "last");
});

test("leaves ordinary focus movement to the browser", () => {
  const controls = ["first", "middle", "last"];
  assert.equal(resolveFocusTrapTarget(controls, "middle", false), null);
  assert.equal(resolveFocusTrapTarget(controls, "middle", true), null);
  assert.equal(resolveFocusTrapTarget([], "outside", false), null);
});
