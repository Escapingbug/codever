import assert from "node:assert/strict";
import test from "node:test";
import {
  disableWebPushNotifications,
  enableWebPushNotifications,
  synchronizeWebPushNotifications,
} from "../app/webPushNotifications.ts";

test("enables, confirms and disables a browser Web Push subscription", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  const vapidPublicKey = "B".repeat(87);
  let activeSubscription: FakePushSubscription | null = null;
  const sent: unknown[] = [];
  const storage = memoryStorage();
  const registration = {
    pushManager: {
      async getSubscription() {
        return activeSubscription;
      },
      async subscribe(options: PushSubscriptionOptionsInit) {
        activeSubscription = new FakePushSubscription(
          options.applicationServerKey as ArrayBuffer,
          () => {
            activeSubscription = null;
          },
        );
        return activeSubscription;
      },
    },
  };
  const notification = {
    permission: "default" as NotificationPermission,
    async requestPermission() {
      notification.permission = "granted";
      return notification.permission;
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { Notification: notification, PushManager: class {}, localStorage: storage },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: { ready: Promise.resolve(registration) } },
  });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: notification,
  });

  try {
    const client = {
      async updateWebPushSubscription(subscription: unknown) {
        sent.push(subscription);
        return { completion: Promise.resolve({ outcome: "succeeded" }) };
      },
    };
    assert.deepEqual(await enableWebPushNotifications({
      client,
      gatewayId: "gateway-1",
      vapidPublicKey,
      storage,
    }), { status: "enabled" });
    assert.equal(typeof (sent[0] as { endpoint?: unknown }).endpoint, "string");

    assert.deepEqual(await synchronizeWebPushNotifications({
      client,
      gatewayId: "gateway-1",
      vapidPublicKey,
      storage,
      now: Date.now() + 24 * 60 * 60_000 + 1,
    }), { status: "enabled" });
    assert.equal(typeof (sent[1] as { endpoint?: unknown }).endpoint, "string");

    assert.deepEqual(await disableWebPushNotifications({
      client,
      gatewayId: "gateway-1",
      storage,
    }), { status: "prompt" });
    assert.equal(activeSubscription, null);
    assert.equal(sent[2], null);
  } finally {
    restoreGlobal("window", originalWindow);
    restoreGlobal("navigator", originalNavigator);
    restoreGlobal("Notification", originalNotification);
  }
});

class FakePushSubscription {
  readonly endpoint = "https://push.example.test/subscriptions/browser-1";
  readonly expirationTime = null;
  readonly options: PushSubscriptionOptions;

  constructor(applicationServerKey: ArrayBuffer, private readonly onUnsubscribe: () => void) {
    this.options = { userVisibleOnly: true, applicationServerKey };
  }

  toJSON(): PushSubscriptionJSON {
    return {
      endpoint: this.endpoint,
      expirationTime: null,
      keys: { p256dh: "A".repeat(88), auth: "B".repeat(22) },
    };
  }

  async unsubscribe(): Promise<boolean> {
    this.onUnsubscribe();
    return true;
  }

  getKey(): ArrayBuffer | null {
    return null;
  }
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
