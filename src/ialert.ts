import { ApiClient, type InboxEntry } from "./api.ts";
import { IAlertError } from "./errors.ts";
import { GatewayConnection, type WebSocketFactory } from "./gateway.ts";
import { Store, defaultStorage } from "./storage.ts";
import type { AckEvent, AuthRequestInfo, AuthRequestResult, ConnectionState, Device, EnableWebPushOptions, IAlertMessage, InitOptions, KeyValueStorage, PushSubscriptionLike, RegisterOptions, TagValue, UpdateOptions, WebPushEnvironment } from "./types.ts";

export const SDK_VERSION = "0.5.0";

const TAG_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const SEEN_LIMIT = 500;

export interface IAlertOptions {
    /** Public key of the app (`ia_pk_…`); it can only register and manage its own device. */
    publicKey: string;
    apiUrl?: string;
    gatewayUrl?: string;
    storage?: KeyValueStorage;
    fetch?: typeof globalThis.fetch;
    WebSocket?: WebSocketFactory;
    /** Connect to the Gateway right after `register()`; default true. */
    autoConnect?: boolean;
    /** Ack "delivered" for every message handed to listeners; default true. */
    autoAckDelivered?: boolean;
    /** Browser APIs for Web Push; defaults to `navigator.serviceWorker` and `Notification`. */
    webPush?: WebPushEnvironment;
    /**
     * Show Gateway and Inbox messages as system notifications while the tab is
     * hidden (when Web Push servers are unreachable, e.g. during an outage); default true.
     */
    showNotificationsWhenHidden?: boolean;
}

interface Registration {
    deviceId: string;
    deviceToken: string;
}

type MessageListener = (message: IAlertMessage) => void;
type StateListener = (state: ConnectionState) => void;

/**
 * iAlert Web SDK. Registers the browser as a `web` device, keeps a Gateway
 * socket open while the page is open, syncs the Inbox after every (re)connect
 * and hands each notification to listeners exactly once.
 */
export class IAlert {
    private readonly api: ApiClient;
    private readonly store: Store;
    private readonly options: IAlertOptions;
    private readonly messageListeners = new Set<MessageListener>();
    private readonly stateListeners = new Set<StateListener>();
    private gateway: GatewayConnection | null = null;
    private seen: string[];
    private syncing: Promise<IAlertMessage[]> | null = null;

    constructor(options: IAlertOptions) {
        if (!options.publicKey.startsWith("ia_pk_")) {
            throw new IAlertError(0, "invalid_public_key", "Use the app's public key (ia_pk_…); secret keys must never ship to browsers.");
        }

        this.options = options;
        const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
        this.api = new ApiClient(options.apiUrl ?? "https://api.ialert.ir/api/v1", options.publicKey, fetchFn);
        this.store = new Store(options.storage ?? defaultStorage(), options.publicKey.slice(-12));
        this.seen = this.store.get<string[]>("seen") ?? [];
    }

    /**
     * One-line setup: registers this browser, connects to the Gateway and turns on
     * Web Push. When permission was already granted it subscribes silently;
     * otherwise it asks on the user's first click or key press. Failures of the
     * Web Push step never stop the Gateway and Inbox from working.
     */
    static init(options: IAlertOptions & InitOptions): IAlert {
        const { serviceWorkerUrl, promptOnInteraction, externalUserId, tags, locale, timezone, appVersion, ...sdkOptions } = options;
        const ialert = new IAlert(sdkOptions);
        const register = { externalUserId, tags, locale, timezone, appVersion };
        ialert.ready = ialert.setUp(register, serviceWorkerUrl, promptOnInteraction !== false);

        return ialert;
    }

    /** Resolves when `init()` finished its first registration (rejects if it failed). */
    ready: Promise<Device | null> = Promise.resolve(null);

    private async setUp(register: Omit<RegisterOptions, "pushToken">, serviceWorkerUrl: string | undefined, promptOnInteraction: boolean): Promise<Device> {
        const fields = Object.fromEntries(Object.entries(register).filter(([, value]) => value !== undefined)) as Omit<RegisterOptions, "pushToken">;
        const device = await this.register(fields);
        let browser: WebPushEnvironment;

        try {
            browser = this.webPushEnvironment();
        } catch {
            return device; // no Web Push in this browser: Gateway and Inbox only
        }

        const enable = () => this.enableWebPush({ serviceWorkerUrl, register: fields }).catch(() => null);
        const permission = browser.permission?.() ?? "default";

        if (permission === "granted") {
            return (await enable()) ?? device;
        }

        const doc = (globalThis as { document?: Document }).document;

        if (permission === "default" && promptOnInteraction && doc) {
            const once = () => {
                doc.removeEventListener("click", once, true);
                doc.removeEventListener("keydown", once, true);
                void enable();
            };
            doc.addEventListener("click", once, true);
            doc.addEventListener("keydown", once, true);
        }

        return device;
    }

    /** The registered device id, or null before `register()`. */
    get deviceId(): string | null {
        return this.registration()?.deviceId ?? null;
    }

    /**
     * Register (or re-register) this browser. Safe to call on every page load:
     * the same installation id maps to the same device and re-subscribes it.
     */
    async register(options: RegisterOptions = {}): Promise<Device> {
        const result = await this.api.register({
            platform: "web",
            push_token: options.pushToken ?? this.installationId(),
            installation_id: this.installationId(),
            sdk_version: SDK_VERSION,
            ...this.deviceFields(options),
            ...this.environmentFields(options),
        });

        this.store.set("registration", { deviceId: result.data.id, deviceToken: result.device_token } satisfies Registration);

        if (this.options.autoConnect !== false) {
            this.connect();
        }

        return result.data;
    }

    /**
     * Turn on browser notifications that arrive even when the site is closed.
     * Asks the user for permission, subscribes with the app's VAPID key and
     * registers the subscription; the Gateway and Inbox keep working as before.
     * Call it from a user gesture (a click), as browsers require for the prompt.
     */
    async enableWebPush(options: EnableWebPushOptions = {}): Promise<Device> {
        const browser = this.webPushEnvironment();

        if ((await browser.requestPermission()) !== "granted") {
            throw new IAlertError(0, "permission_denied", "The user did not allow notifications.");
        }

        const vapidKey = options.vapidPublicKey ?? (await this.api.webPushConfig()).vapid_public_key;

        if (!vapidKey) {
            throw new IAlertError(0, "web_push_not_configured", "Generate the app's Web Push keys in the iAlert panel first.");
        }

        this.listenToServiceWorker(browser);
        await browser.serviceWorker.register(options.serviceWorkerUrl ?? "/ialert-sw.js");
        const { pushManager } = await browser.serviceWorker.ready;
        const applicationServerKey = base64UrlToBytes(vapidKey);

        let subscription = await pushManager.getSubscription();

        if (subscription !== null && !sameKey(subscription, applicationServerKey)) {
            await subscription.unsubscribe();
            subscription = null;
        }

        subscription ??= await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });

        const previous = this.registration();
        const device = await this.register({ ...options.register, pushToken: JSON.stringify(subscription.toJSON()) });

        // The Gateway-only registration (installation id) is a different device; retire it.
        if (previous !== null && previous.deviceId !== device.id) {
            void this.api.unsubscribe(previous.deviceId, previous.deviceToken).catch(() => undefined);
        }

        return device;
    }

    /**
     * Approve or deny an Auth Push sign-in request (see `authRequestOf(message)`).
     * With number matching pass the number the user typed; a wrong one denies.
     */
    async respondToAuthRequest(requestId: string, approve: boolean, code?: string): Promise<AuthRequestResult> {
        const registration = await this.requireRegistration();

        return this.withToken(() => this.api.respondToAuthRequest(registration.deviceId, registration.deviceToken, requestId, approve ? "approve" : "deny", code), false);
    }

    /** Update the external user id, tags (merged) or locale of this device. */
    async update(options: UpdateOptions): Promise<Device> {
        const registration = this.requireRegistration();

        return this.withToken(() => this.api.update(registration.deviceId, registration.deviceToken, this.deviceFields(options)));
    }

    setTags(tags: Record<string, TagValue | null>): Promise<Device> {
        return this.update({ tags });
    }

    setExternalUserId(externalUserId: string | null): Promise<Device> {
        return this.update({ externalUserId });
    }

    /** Stop receiving notifications; call `register()` to subscribe again. */
    async unsubscribe(): Promise<Device> {
        const registration = this.requireRegistration();
        this.disconnect();

        return this.withToken(() => this.api.unsubscribe(registration.deviceId, registration.deviceToken));
    }

    /** Open the Gateway socket (done by `register()` unless `autoConnect: false`). */
    connect(): void {
        const registration = this.requireRegistration();
        const WebSocketImpl = this.options.WebSocket ?? globalThis.WebSocket;

        if (this.gateway !== null || WebSocketImpl === undefined) {
            return;
        }

        this.gateway = new GatewayConnection({
            url: this.options.gatewayUrl ?? "wss://gw.ialert.ir/v1/connect",
            deviceToken: registration.deviceToken,
            WebSocket: WebSocketImpl,
            handlers: {
                onReady: () => {
                    void this.syncInbox().catch(() => undefined);
                },
                onMessage: (message) => this.receive(this.fromGateway(message)),
                onUnauthorized: () => {
                    this.gateway = null;
                    this.store.remove("registration");
                    this.emitState("closed");
                },
                onStateChange: (state) => this.emitState(state),
            },
        });
        this.gateway.start();
    }

    disconnect(): void {
        this.gateway?.stop();
        this.gateway = null;
    }

    /**
     * Pull Inbox entries not yet delivered here (missed while the page was closed)
     * and hand the new ones to listeners. Concurrent calls share one request.
     */
    syncInbox(): Promise<IAlertMessage[]> {
        this.syncing ??= this.pullInbox().finally(() => {
            this.syncing = null;
        });

        return this.syncing;
    }

    /** Report that the user read or clicked notifications (by notification id). */
    async ack(ids: string[], event: AckEvent): Promise<void> {
        if (ids.length === 0) {
            return;
        }

        const registration = this.requireRegistration();

        if (this.gateway?.isReady) {
            this.gateway.ack(ids, event);

            return;
        }

        await this.withToken(() => this.api.ack(registration.deviceId, registration.deviceToken, ids, event));
    }

    /** Listen for notifications; returns a function that removes the listener. */
    onMessage(listener: MessageListener): () => void {
        this.messageListeners.add(listener);

        return () => this.messageListeners.delete(listener);
    }

    onConnectionStateChange(listener: StateListener): () => void {
        this.stateListeners.add(listener);

        return () => this.stateListeners.delete(listener);
    }

    private async pullInbox(): Promise<IAlertMessage[]> {
        const registration = this.requireRegistration();
        const entries = await this.withToken(() => this.api.inbox(registration.deviceId, registration.deviceToken, true));
        // Oldest first, so listeners see messages in the order they were sent.
        const received = [...entries]
            .reverse()
            .map((entry) => this.fromInbox(entry))
            .filter((message) => this.receive(message, false));

        if (this.options.autoAckDelivered !== false) {
            const undelivered = entries.filter((entry) => entry.delivered_at === null).map((entry) => entry.id);
            await this.ack(undelivered, "delivered").catch(() => undefined);
        }

        return received;
    }

    private listening = false;

    /** Pushes and clicks the service worker forwards to open pages. */
    private listenToServiceWorker(browser: WebPushEnvironment): void {
        if (this.listening) {
            return;
        }

        this.listening = true;
        browser.serviceWorker.addEventListener("message", (event: Event) => {
            const data = (event as MessageEvent).data as { type?: string; message?: Record<string, unknown>; id?: string } | undefined;

            if (data?.type === "ialert:message" && data.message?.id !== undefined) {
                this.receive({ ...this.fromGateway(data.message), source: "push" });
            } else if (data?.type === "ialert:click" && typeof data.id === "string" && this.registration() !== null) {
                void this.ack([data.id], "clicked").catch(() => undefined);
            }
        });
    }

    private webPushEnvironment(): WebPushEnvironment {
        if (this.options.webPush) {
            return this.options.webPush;
        }

        const nav = globalThis.navigator as Navigator | undefined;
        const notification = (globalThis as { Notification?: typeof Notification }).Notification;

        if (!nav?.serviceWorker || !("PushManager" in globalThis) || !notification) {
            throw new IAlertError(0, "web_push_unsupported", "This browser does not support Web Push.");
        }

        return {
            serviceWorker: nav.serviceWorker as unknown as WebPushEnvironment["serviceWorker"],
            requestPermission: () => notification.requestPermission(),
            permission: () => notification.permission,
            isHidden: () => (globalThis as { document?: Document }).document?.visibilityState === "hidden",
            showNotification: (message) => {
                const options: NotificationOptions & { image?: string } = {
                    body: message.title ? (message.body ?? "") : "",
                    tag: message.collapse_id ?? message.id,
                    silent: message.sound === "none",
                    data: { ialert: { ...message, source: undefined } },
                };

                if (message.image) {
                    options.image = message.image;
                }

                void nav.serviceWorker.getRegistration().then((registration) => {
                    if (registration) {
                        return registration.showNotification(message.title || message.body || "", options);
                    }

                    const shown = new notification(message.title || message.body || "", options);
                    shown.onclick = () => {
                        shown.close();
                        globalThis.focus?.();
                        void this.ack([message.id], "clicked").catch(() => undefined);
                        if (message.url) {
                            globalThis.open?.(message.url, "_blank", "noopener");
                        }
                    };
                }).catch(() => undefined);
            },
        };
    }

    /** Dedupe by notification id across Gateway, Inbox and page loads. */
    private receive(message: IAlertMessage, ack = true): boolean {
        if (this.hasSeen(message.id)) {
            return false;
        }

        this.seen.push(message.id);
        this.seen = this.seen.slice(-SEEN_LIMIT);
        this.store.set("seen", this.seen);

        for (const listener of this.messageListeners) {
            try {
                listener(message);
            } catch (error) {
                queueMicrotask(() => {
                    throw error;
                });
            }
        }

        this.showIfHidden(message);

        if (ack && this.options.autoAckDelivered !== false) {
            void this.ack([message.id], "delivered").catch(() => undefined);
        }

        return true;
    }

    /** A hidden tab would miss a Gateway/Inbox message; show it as a system notification. */
    private showIfHidden(message: IAlertMessage): void {
        if (message.source === "push" || this.options.showNotificationsWhenHidden === false) {
            return;
        }

        let browser: WebPushEnvironment;

        try {
            browser = this.webPushEnvironment();
        } catch {
            return; // no notifications in this environment
        }

        const hidden = browser.isHidden?.() ?? false;

        if (!hidden || message.data.ialert_type === "auth_request" || (!message.title && !message.body)) {
            return;
        }

        if ((browser.permission?.() ?? "default") === "granted") {
            browser.showNotification?.(message);
        }
    }

    private hasSeen(id: string): boolean {
        return this.seen.includes(id);
    }

    private fromGateway(message: Record<string, unknown>): IAlertMessage {
        const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

        return {
            id: String(message.id),
            title: text(message.title),
            body: text(message.body),
            image: text(message.image),
            data: message.data !== null && typeof message.data === "object" && !Array.isArray(message.data) ? (message.data as Record<string, unknown>) : {},
            collapse_id: text(message.collapse_id),
            created_at: text(message.created_at),
            source: "gateway",
            sound: text(message.sound),
            url: clickUrl(text(message.url), message.data),
        };
    }

    private fromInbox(entry: InboxEntry): IAlertMessage {
        const data = entry.content.data;

        return {
            id: entry.id,
            title: entry.content.title,
            body: entry.content.body,
            image: entry.content.image,
            data: data !== null && !Array.isArray(data) ? data : {},
            collapse_id: entry.collapse_id,
            created_at: entry.created_at,
            source: "inbox",
            sound: entry.content.sound ?? null,
            url: clickUrl(entry.content.url ?? null, data),
        };
    }

    private deviceFields(options: UpdateOptions): Record<string, unknown> {
        const fields: Record<string, unknown> = {};

        if (options.externalUserId !== undefined) {
            fields.external_user_id = options.externalUserId;
        }

        if (options.tags !== undefined) {
            const invalid = Object.keys(options.tags).filter((key) => !TAG_KEY.test(key));

            if (invalid.length > 0) {
                throw new IAlertError(0, "invalid_tag_key", `Tag keys must match [A-Za-z0-9_.:-]{1,64}: ${invalid.join(", ")}`);
            }

            fields.tags = options.tags;
        }

        if (options.locale !== undefined) {
            fields.locale = options.locale;
        }

        if (options.timezone !== undefined) {
            fields.timezone = options.timezone;
        }

        if (options.appVersion !== undefined) {
            fields.app_version = options.appVersion;
        }

        return fields;
    }

    /** Locale, timezone and browser details detected when the caller does not set them. */
    private environmentFields(options: RegisterOptions): Record<string, unknown> {
        const fields: Record<string, unknown> = {};
        const navigatorInfo = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;

        if (options.locale === undefined && navigatorInfo?.language) {
            fields.locale = navigatorInfo.language;
        }

        if (options.timezone === undefined) {
            try {
                fields.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            } catch {
                // ignore
            }
        }

        const userAgent = navigatorInfo?.userAgent;

        if (userAgent) {
            fields.device_model = detectBrowser(userAgent);
            fields.os_version = navigatorInfo?.userAgentData?.platform ?? detectOs(userAgent);
        }

        return Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value === "string" && value !== ""));
    }

    private installationId(): string {
        let id = this.store.get<string>("installation");

        if (id === null) {
            id = `ia_web_${globalThis.crypto.randomUUID()}`;
            this.store.set("installation", id);
        }

        return id;
    }

    private registration(): Registration | null {
        return this.store.get<Registration>("registration");
    }

    private requireRegistration(): Registration {
        const registration = this.registration();

        if (registration === null) {
            throw new IAlertError(0, "not_registered", "Call register() first.");
        }

        return registration;
    }

    /** A rejected device token means the device was deleted or unsubscribed elsewhere. */
    /**
     * A rejected device token means the device was deleted or unsubscribed elsewhere.
     * A 404 means the same, except where the path also names another resource.
     */
    private async withToken<T>(call: () => Promise<T>, forgetOnNotFound = true): Promise<T> {
        try {
            return await call();
        } catch (error) {
            if (error instanceof IAlertError && (error.code === "device_token_invalid" || (forgetOnNotFound && error.status === 404))) {
                this.disconnect();
                this.store.remove("registration");
            }

            throw error;
        }
    }

    private emitState(state: ConnectionState): void {
        for (const listener of this.stateListeners) {
            listener(state);
        }
    }
}

function detectBrowser(userAgent: string): string {
    const match = /(Edg|OPR|SamsungBrowser|Firefox|Chrome|Safari)\/(\d+)/.exec(userAgent);

    if (match === null) {
        return "Browser";
    }

    const names: Record<string, string> = { Edg: "Edge", OPR: "Opera", SamsungBrowser: "Samsung Internet" };

    return `${names[match[1] ?? ""] ?? match[1]} ${match[2]}`;
}

function detectOs(userAgent: string): string {
    for (const [pattern, name] of [
        [/Android/, "Android"],
        [/iPhone|iPad|iPod/, "iOS"],
        [/Windows/, "Windows"],
        [/Mac OS X/, "macOS"],
        [/Linux/, "Linux"],
    ] as const) {
        if (pattern.test(userAgent)) {
            return name;
        }
    }

    return "Unknown";
}

function base64UrlToBytes(value: string): Uint8Array {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(base64);

    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Whether an existing subscription was made with this VAPID key (a new key needs a new subscription). */
function sameKey(subscription: PushSubscriptionLike, key: Uint8Array): boolean {
    const current = subscription.options?.applicationServerKey;

    if (!current) {
        return true;
    }

    const bytes = new Uint8Array(current);

    return bytes.length === key.length && bytes.every((byte, index) => byte === key[index]);
}

/** The Auth Push request a message carries, or `null` for other messages. */
export function authRequestOf(message: { data: Record<string, unknown> }): AuthRequestInfo | null {
    const data = message.data;

    if (data.ialert_type !== "auth_request" || typeof data.auth_request_id !== "string") {
        return null;
    }

    const reserved = new Set(["ialert_type", "auth_request_id", "number_matching", "expires_at"]);
    const context: Record<string, string> = {};

    for (const [key, value] of Object.entries(data)) {
        if (!reserved.has(key) && typeof value === "string") {
            context[key] = value;
        }
    }

    return {
        id: data.auth_request_id,
        numberMatching: data.number_matching === "1" || data.number_matching === true,
        expiresAt: typeof data.expires_at === "string" ? data.expires_at : null,
        context,
    };
}

/** The notification's `url`, or `data.url` of messages sent before that field existed. */
function clickUrl(url: string | null, data: unknown): string | null {
    if (url) {
        return url;
    }

    const legacy = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).url : null;

    return typeof legacy === "string" && legacy !== "" ? legacy : null;
}
