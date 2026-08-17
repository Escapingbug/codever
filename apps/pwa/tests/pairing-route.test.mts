import assert from "node:assert/strict";
import test from "node:test";
import { hasPairingRoute, pairingRouteFromUrl } from "../app/pairingRoute.ts";

test("extracts a pairing invitation received by an already running app", () => {
  const route = pairingRouteFromUrl(
    "https://codever.example/work#session=keep&pair=codever%3A%2F%2Fpair%3Fdata%3Done",
  );
  assert.equal(route.pairingLink, "codever://pair?data=one");
  assert.equal(route.sanitizedPath, "/work#session=keep");
  assert.equal(hasPairingRoute(route), true);
});

test("keeps short invitation material long enough to resolve it and then removes it from history", () => {
  const route = pairingRouteFromUrl("https://codever.example/#i=abc&k=secret");
  assert.match(route.shortInvitation ?? "", /#i=abc&k=secret$/u);
  assert.equal(route.sanitizedPath, "/");
});
