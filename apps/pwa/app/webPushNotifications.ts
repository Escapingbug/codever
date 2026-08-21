import {
  webPushSubscriptionSchema,
  type WebPushSubscription as Cvp3WebPushSubscription,
} from "@codever/protocol";
import type { CodeverClient } from "./client/CodeverClient";

const RESYNC_INTERVAL_MS = 24 * 60 * 60_000;
const COMMAND_COMPLETION_TIMEOUT_MS = 30_000;
const MARKER_PREFIX = "codever.web-push.v1";

export type WebPushNotificationState =
  | { status: "unsupported" }
  | { status: "unavailable" }
  | { status: "prompt" }
  | { status: "blocked" }
  | { status: "enabled" }
  | { status: "error"; detail: string };

type NotificationClient = Pick<CodeverClient, "updateWebPushSubscription">;

export async function inspectWebPushNotifications(
  vapidPublicKey: string | undefined,
): Promise<WebPushNotificationState> {
  if (!supportsWebPush()) return { status: "unsupported" };
  if (!vapidPublicKey) return { status: "unavailable" };
  if (Notification.permission === "denied") return { status: "blocked" };
  if (Notification.permission !== "granted") return { status: "prompt" };
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription && subscriptionUsesKey(subscription, vapidPublicKey)
    ? { status: "enabled" }
    : { status: "prompt" };
}

export async function enableWebPushNotifications(input: {
  client: NotificationClient
  gatewayId: string
  vapidPublicKey: string
  storage?: Storage
}): Promise<WebPushNotificationState> {
  if (!supportsWebPush()) return { status: "unsupported" };
  const permission = await Notification.requestPermission();
  if (permission === "denied") return { status: "blocked" };
  if (permission !== "granted") return { status: "prompt" };
  requireClient(input.client);
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !subscriptionUsesKey(subscription, input.vapidPublicKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeBase64Url(input.vapidPublicKey),
  });
  const serialized = serializeSubscription(subscription);
  const command = await input.client.updateWebPushSubscription!(serialized);
  await withTimeout(command.completion);
  writeMarker(
    input.storage ?? window.localStorage,
    input.gatewayId,
    input.vapidPublicKey,
    serialized.endpoint,
  );
  return { status: "enabled" };
}

export async function synchronizeWebPushNotifications(input: {
  client: NotificationClient
  gatewayId: string
  vapidPublicKey: string
  storage?: Storage
  now?: number
}): Promise<WebPushNotificationState> {
  const state = await inspectWebPushNotifications(input.vapidPublicKey);
  if (state.status !== "enabled") return state;
  requireClient(input.client);
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return { status: "prompt" };
  if (!subscriptionUsesKey(subscription, input.vapidPublicKey)) {
    await subscription.unsubscribe();
    clearMarker(input.storage ?? window.localStorage, input.gatewayId);
    return { status: "prompt" };
  }
  const serialized = serializeSubscription(subscription);
  const storage = input.storage ?? window.localStorage;
  const marker = readMarker(storage, input.gatewayId);
  const now = input.now ?? Date.now();
  if (
    marker
    && marker.vapidPublicKey === input.vapidPublicKey
    && marker.endpoint === serialized.endpoint
    && now - marker.syncedAt < RESYNC_INTERVAL_MS
  ) return { status: "enabled" };
  const command = await input.client.updateWebPushSubscription!(serialized);
  await withTimeout(command.completion);
  writeMarker(storage, input.gatewayId, input.vapidPublicKey, serialized.endpoint, now);
  return { status: "enabled" };
}

export async function disableWebPushNotifications(input: {
  client: NotificationClient
  gatewayId: string
  storage?: Storage
}): Promise<WebPushNotificationState> {
  if (!supportsWebPush()) return { status: "unsupported" };
  requireClient(input.client);
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  await subscription?.unsubscribe();
  clearMarker(input.storage ?? window.localStorage, input.gatewayId);
  try {
    const command = await input.client.updateWebPushSubscription!(null);
    await withTimeout(command.completion);
  } catch (error) {
    throw new Error(
      "Notifications are disabled in this browser, but the Gateway could not confirm removal yet.",
      { cause: error },
    );
  }
  return Notification.permission === "denied"
    ? { status: "blocked" }
    : { status: "prompt" };
}

function supportsWebPush(): boolean {
  return typeof window !== "undefined"
    && "Notification" in window
    && "serviceWorker" in navigator
    && "PushManager" in window;
}

function requireClient(client: NotificationClient): void {
  if (!client.updateWebPushSubscription) {
    throw new Error("This connection does not support Web Push notifications.");
  }
}

function serializeSubscription(subscription: PushSubscription): Cvp3WebPushSubscription {
  const json = subscription.toJSON();
  return webPushSubscriptionSchema.parse({
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime,
    keys: {
      p256dh: json.keys?.p256dh,
      auth: json.keys?.auth,
    },
  });
}

function subscriptionUsesKey(
  subscription: PushSubscription,
  vapidPublicKey: string,
): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const expected = decodeBase64Url(vapidPublicKey);
  const actual = new Uint8Array(current);
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/")
    + "=".repeat((4 - value.length % 4) % 4);
  const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0));
  return new Uint8Array(bytes.buffer);
}

type SyncMarker = {
  version: 1
  vapidPublicKey: string
  endpoint: string
  syncedAt: number
};

function markerKey(gatewayId: string): string {
  return `${MARKER_PREFIX}.${gatewayId}`;
}

function readMarker(storage: Storage, gatewayId: string): SyncMarker | null {
  try {
    const value = JSON.parse(storage.getItem(markerKey(gatewayId)) ?? "null") as Partial<SyncMarker>;
    return value?.version === 1
      && typeof value.vapidPublicKey === "string"
      && typeof value.endpoint === "string"
      && Number.isSafeInteger(value.syncedAt)
      ? value as SyncMarker
      : null;
  } catch {
    return null;
  }
}

function writeMarker(
  storage: Storage,
  gatewayId: string,
  vapidPublicKey: string,
  endpoint: string,
  syncedAt = Date.now(),
): void {
  storage.setItem(markerKey(gatewayId), JSON.stringify({
    version: 1,
    vapidPublicKey,
    endpoint,
    syncedAt,
  } satisfies SyncMarker));
}

function clearMarker(storage: Storage, gatewayId: string): void {
  storage.removeItem(markerKey(gatewayId));
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("The Gateway did not confirm the notification change in time.")),
          COMMAND_COMPLETION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
