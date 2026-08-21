// v8 adds Web Push notification delivery. Changing the worker bytes makes
// existing installations activate the updater once;
// subsequent application builds are detected through /api/version.
const CACHE_NAME = "codever-shell-v8";
const PUSH_DEDUPE_CACHE = "codever-push-dedupe-v1";
const PUSH_DEDUPE_LIMIT = 256;
const APP_SHELL = ["/", "/manifest.webmanifest", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        APP_SHELL.map(async (url) => {
          const response = await fetch(url, { cache: "reload" });
          if (!response.ok) {
            throw new Error(`Could not refresh the app shell: ${url}`);
          }
          await cache.put(url, response);
        }),
      ),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME && key !== PUSH_DEDUPE_CACHE)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const requestUrl = new URL(event.request.url);
  if (
    requestUrl.origin === self.location.origin &&
    (
      requestUrl.pathname.startsWith("/_matrix/") ||
      requestUrl.pathname === "/api/version"
    )
  ) {
    // The homeserver shares this origin in production. Matrix /sync is a
    // credentialed long poll and must never be cached or replayed by the app
    // shell worker. The deployment version is also authoritative and must
    // never fall back to a cached response; leaving these requests unhandled
    // sends them directly to the network.
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("/", copy));
          }
          return response;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (
          response.ok &&
          requestUrl.origin === self.location.origin
        ) {
          const copy = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("push", (event) => {
  event.waitUntil(handleCodeverPush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openNotificationTarget(event.notification.data));
});

async function handleCodeverPush(event) {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    return;
  }
  if (!validPushPayload(payload)) return;
  if (!await claimPushEvent(payload.eventId)) return;

  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of windows) {
    client.postMessage({ type: "CODEVER_PUSH_RECEIVED", payload });
  }
  if (windows.some((client) => client.visibilityState === "visible")) return;

  const presentation = notificationPresentation(payload.status);
  await self.registration.showNotification(presentation.title, {
    body: presentation.body,
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    tag: `codever-turn-${payload.eventId}`,
    renotify: false,
    data: {
      type: "codever.turn-terminal",
      sessionId: payload.sessionId,
    },
  });
}

async function claimPushEvent(eventId) {
  const cache = await caches.open(PUSH_DEDUPE_CACHE);
  const key = new URL(
    `/__codever_push_seen__/${encodeURIComponent(eventId)}`,
    self.location.origin,
  ).href;
  if (await cache.match(key)) return false;
  await cache.put(key, new Response("", {
    headers: { "x-codever-push-received-at": String(Date.now()) },
  }));
  const keys = await cache.keys();
  await Promise.all(
    keys.slice(0, Math.max(0, keys.length - PUSH_DEDUPE_LIMIT))
      .map((request) => cache.delete(request)),
  );
  return true;
}

async function openNotificationTarget(data) {
  if (
    !data ||
    data.type !== "codever.turn-terminal" ||
    !validOpaqueId(data.sessionId)
  ) return;
  const route = `/#session=${encodeURIComponent(data.sessionId)}`;
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const target = windows[0];
  if (target) {
    if ("navigate" in target) await target.navigate(route);
    await target.focus();
    return;
  }
  await self.clients.openWindow(route);
}

function validPushPayload(value) {
  return Boolean(
    value &&
    value.version === 1 &&
    value.type === "codever.turn-terminal" &&
    validOpaqueId(value.eventId) &&
    validOpaqueId(value.workspaceId) &&
    validOpaqueId(value.projectId) &&
    validOpaqueId(value.sessionId) &&
    ["succeeded", "cancelled", "failed"].includes(value.status),
  );
}

function validOpaqueId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function notificationPresentation(status) {
  if (status === "failed") {
    return {
      title: "Agent task needs attention",
      body: "The task failed. Tap to view the session.",
    };
  }
  if (status === "cancelled") {
    return {
      title: "Agent task cancelled",
      body: "Tap to return to the session.",
    };
  }
  return {
    title: "Agent task completed",
    body: "Tap to view the result.",
  };
}
