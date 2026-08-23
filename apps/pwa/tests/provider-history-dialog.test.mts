import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderHistoryDialog } from "../app/ProviderHistoryDialog.tsx";

test("keeps provider history dismissible while sessions load", () => {
  const html = renderToStaticMarkup(createElement(ProviderHistoryDialog, {
    open: true,
    provider: "codex",
    providers: [{
      id: "codex",
      name: "Codex",
      canListSessions: true,
      canInspectSessions: true,
    }],
    sessions: [],
    selected: null,
    messages: [],
    loading: "sessions",
    error: null,
    onClose() {},
    onProviderChange() {},
    onInspect() {},
    onRetry() {},
    onOpenManaged() {},
    onContinue() {},
  }));

  const closeButton = html.match(
    /<button(?=[^>]*aria-label="Close provider history")[^>]*>/,
  )?.[0];
  assert.ok(closeButton);
  assert.doesNotMatch(closeButton, /disabled/);
  assert.match(html, /Loading provider sessions in the background/);
  assert.match(html, /You can close this window while sessions load/);
});

test("keeps the provider history retry action after a background failure", () => {
  const html = renderToStaticMarkup(createElement(ProviderHistoryDialog, {
    open: true,
    provider: "codex",
    providers: [],
    sessions: [],
    selected: null,
    messages: [],
    loading: null,
    error: "Provider history could not be loaded.",
    onClose() {},
    onProviderChange() {},
    onInspect() {},
    onRetry() {},
    onOpenManaged() {},
    onContinue() {},
  }));

  assert.match(html, /Provider history could not be loaded/);
  assert.match(html, /<button type="button">Retry<\/button>/);
});
