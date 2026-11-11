import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IAlert, IAlertError, type IAlertMessage, type PushSubscriptionLike, type WebPushEnvironment } from "../src/index.ts";
import { ackResponder, fakeFetch, flush, inboxEntry, inboxResponder, newStorage } from "./helpers.ts";

const PUBLIC_KEY = "ia_pk_live_abcdefghijkl_secret";
const VAPID = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";

function keyBytes(value: string): Uint8Array {
    return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

class FakeSubscription implements PushSubscriptionLike {
    unsubscribed = false;
    readonly endpoint: string;
    options: { applicationServerKey?: ArrayBuffer | null };
    constructor(endpoint: string, key: Uint8Array) {
        this.endpoint = endpoint;
        this.options = { applicationServerKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer };
    }
    toJSON() {
        return { endpoint: this.endpoint, expirationTime: null, keys: { p256dh: "p256dh-key", auth: "auth-key" } };
    }
    async unsubscribe() {
        this.unsubscribed = true;
        return true;
    }
}

function fakeBrowser(permission: NotificationPermission = "granted", existing: FakeSubscription | null = null) {
    const listeners: ((event: Event) => void)[] = [];
    const calls = { registered: [] as string[], subscribedWith: [] as Uint8Array[] };
    let current = existing;

    const browser: WebPushEnvironment = {
        requestPermission: async () => permission,
        serviceWorker: {
            register: (async (url: string) => {
                calls.registered.push(url);
                return {} as ServiceWorkerRegistration;
            }) as unknown as ServiceWorkerContainer["register"],
            addEventListener: ((type: string, listener: (event: Event) => void) => {
                if (type === "message") listeners.push(listener);
            }) as ServiceWorkerContainer["addEventListener"],
            ready: Promise.resolve({
                pushManager: {
                    getSubscription: async () => current,
                    subscribe: async ({ applicationServerKey }) => {
                        calls.subscribedWith.push(applicationServerKey);
                        current = new FakeSubscription("https://fcm.googleapis.com/fcm/send/new", applicationServerKey);
                        return current;
                    },
                },
            }),
        },
    };

    const post = (data: unknown) => listeners.forEach((listener) => listener({ data } as MessageEvent));

    return { browser, calls, post };
}

const configResponder = (request: { method: string; url: string }) =>
    request.method === "GET" && request.url.endsWith("/web-push") ? { body: { data: { enabled: true, vapid_public_key: VAPID } } } : undefined;

let devices = 0;
const registerResponder = (request: { method: string; url: string }) =>
    request.method === "POST" && request.url.endsWith("/devices")
        ? { status: 201, body: { data: { id: `dev_${++devices}`, platform: "web", tags: {} }, device_token: `ia_dt_dev_${devices}.sig` } }
        : undefined;
const unsubscribeResponder = (request: { url: string }) => (request.url.endsWith("/unsubscribe") ? { body: { data: { id: "x", subscribed: false } } } : undefined);

function sdk(fetch: typeof globalThis.fetch, browser: WebPushEnvironment, storage = newStorage()) {
    return new IAlert({ publicKey: PUBLIC_KEY, apiUrl: "https://api.test/api/v1", fetch, storage, webPush: browser, autoConnect: false });
}

describe("web push", () => {
    it("subscribes with the app's VAPID key, registers the subscription and retires the Gateway-only device", async () => {
        devices = 0;
        const { fetch, requests } = fakeFetch(configResponder, registerResponder, unsubscribeResponder);
        const { browser, calls } = fakeBrowser();
        const ialert = sdk(fetch, browser);

        await ialert.register();
        const device = await ialert.enableWebPush({ register: { externalUserId: "user-42" } });
        await flush();

        assert.equal(device.id, "dev_2");
        assert.deepEqual(calls.registered, ["/ialert-sw.js"]);
        assert.deepEqual(Array.from(calls.subscribedWith[0] ?? []), Array.from(keyBytes(VAPID)));

        const registration = requests.filter((r) => r.method === "POST" && r.url.endsWith("/devices"))[1]?.body as Record<string, unknown>;
        assert.equal(registration.platform, "web");
        assert.equal(registration.external_user_id, "user-42");
        assert.deepEqual(JSON.parse(String(registration.push_token)), {
            endpoint: "https://fcm.googleapis.com/fcm/send/new",
            expirationTime: null,
            keys: { p256dh: "p256dh-key", auth: "auth-key" },
        });

        const retired = requests.find((r) => r.url.endsWith("/devices/dev_1/unsubscribe"));
        assert.equal(retired?.headers["X-Device-Token"], "ia_dt_dev_1.sig");
        assert.equal(ialert.deviceId, "dev_2");
    });

    it("re-subscribes when the existing subscription used another key", async () => {
        devices = 0;
        const old = new FakeSubscription("https://fcm.googleapis.com/fcm/send/old", new Uint8Array(65).fill(7));
        const { fetch } = fakeFetch(configResponder, registerResponder);
        const { browser, calls } = fakeBrowser("granted", old);

        await sdk(fetch, browser).enableWebPush();

        assert.equal(old.unsubscribed, true);
        assert.equal(calls.subscribedWith.length, 1);
    });

    it("refuses without permission or without app keys", async () => {
        const { fetch, requests } = fakeFetch((request) => (request.url.endsWith("/web-push") ? { body: { data: { enabled: false, vapid_public_key: null } } } : undefined));

        await assert.rejects(sdk(fetch, fakeBrowser("denied").browser).enableWebPush(), (error: IAlertError) => error.code === "permission_denied");
        assert.equal(requests.length, 0);

        await assert.rejects(sdk(fetch, fakeBrowser().browser).enableWebPush(), (error: IAlertError) => error.code === "web_push_not_configured");
    });

    it("hands pushes from the service worker to listeners once and acks clicks", async () => {
        devices = 0;
        const { fetch, requests } = fakeFetch(configResponder, registerResponder, ackResponder);
        const { browser, post } = fakeBrowser();
        const ialert = sdk(fetch, browser);
        const received: IAlertMessage[] = [];
        ialert.onMessage((message) => received.push(message));

        await ialert.enableWebPush();
        post({ type: "ialert:message", message: { id: "01NOTIF", title: "Hi", body: "There", data: { url: "/orders" } } });
        post({ type: "ialert:message", message: { id: "01NOTIF", title: "Hi" } });
        post({ type: "ialert:click", id: "01NOTIF" });
        await flush();

        assert.equal(received.length, 1);
        assert.equal(received[0]?.source, "push");
        assert.deepEqual(received[0]?.data, { url: "/orders" });

        const acks = requests.filter((r) => r.url.endsWith("/inbox/ack")).map((r) => (r.body as { event: string }).event);
        assert.deepEqual(acks.sort(), ["clicked", "delivered"]);
    });
});

describe("init", () => {
    it("registers and subscribes to Web Push silently when permission was already granted", async () => {
        devices = 0;
        const { fetch } = fakeFetch(configResponder, registerResponder, unsubscribeResponder);
        const { browser, calls } = fakeBrowser();
        browser.permission = () => "granted";

        const ialert = IAlert.init({ publicKey: PUBLIC_KEY, apiUrl: "https://api.test/api/v1", fetch, storage: newStorage(), webPush: browser, autoConnect: false, externalUserId: "user-42" });
        const device = await ialert.ready;

        assert.equal(device?.id, "dev_2");
        assert.deepEqual(calls.registered, ["/ialert-sw.js"]);
    });

    it("keeps the Gateway registration when Web Push is not configured", async () => {
        devices = 0;
        const { fetch } = fakeFetch((r) => (r.url.endsWith("/web-push") ? { body: { data: { enabled: false, vapid_public_key: null } } } : undefined), registerResponder);
        const { browser } = fakeBrowser();
        browser.permission = () => "granted";

        const ialert = IAlert.init({ publicKey: PUBLIC_KEY, apiUrl: "https://api.test/api/v1", fetch, storage: newStorage(), webPush: browser, autoConnect: false });

        assert.equal((await ialert.ready)?.id, "dev_1");
    });

    it("shows a system notification for an Inbox message while the tab is hidden, not for Web Push ones", async () => {
        devices = 0;
        const { fetch } = fakeFetch(configResponder, registerResponder, inboxResponder([inboxEntry("ntf_1")]), ackResponder);
        const { browser, post } = fakeBrowser();
        const shown: IAlertMessage[] = [];
        browser.permission = () => "granted";
        browser.isHidden = () => true;
        browser.showNotification = (message) => shown.push(message);

        const ialert = sdk(fetch, browser);
        await ialert.register();
        await ialert.syncInbox();
        await ialert.enableWebPush();
        post({ type: "ialert:message", message: { id: "ntf_2", title: "push", body: "b", data: {} } });

        assert.deepEqual(shown.map((m) => m.id), ["ntf_1"]);
    });
});
