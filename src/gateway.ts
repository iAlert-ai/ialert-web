import type { AckEvent, ConnectionState } from "./types.ts";

/** Constructor shape of the browser WebSocket (injectable for tests and other runtimes). */
export type WebSocketFactory = new (url: string) => WebSocket;

export interface GatewayHandlers {
    onReady(): void;
    onMessage(message: Record<string, unknown>): void;
    /** The token was rejected: reconnecting would not help. */
    onUnauthorized(): void;
    onStateChange(state: ConnectionState): void;
}

export interface GatewayOptions {
    url: string;
    deviceToken: string;
    WebSocket: WebSocketFactory;
    handlers: GatewayHandlers;
    /** Client ping interval; the Gateway drops a socket after about 75 s of silence. */
    pingIntervalMs?: number;
    minReconnectMs?: number;
    maxReconnectMs?: number;
}

/**
 * One WebSocket to the iAlert Gateway: authenticates with the device token,
 * answers pings, sends acks and reconnects with jittered exponential backoff.
 */
export class GatewayConnection {
    private readonly options: Required<Omit<GatewayOptions, "handlers">> & { handlers: GatewayHandlers };
    private socket: WebSocket | null = null;
    private stopped = true;
    private attempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private ready = false;
    private readonly pendingAcks: { ids: string[]; event: AckEvent }[] = [];

    constructor(options: GatewayOptions) {
        this.options = { pingIntervalMs: 30_000, minReconnectMs: 1_000, maxReconnectMs: 60_000, ...options };
    }

    get isReady(): boolean {
        return this.ready;
    }

    start(): void {
        if (!this.stopped) {
            return;
        }

        this.stopped = false;
        this.open();
    }

    stop(): void {
        this.stopped = true;
        this.clearTimers();
        this.ready = false;

        const socket = this.socket;
        this.socket = null;
        socket?.close(1000);
        this.options.handlers.onStateChange("closed");
    }

    /** Sends an ack now, or once the socket is ready again. */
    ack(ids: string[], event: AckEvent): void {
        for (let start = 0; start < ids.length; start += 100) {
            const chunk = { ids: ids.slice(start, start + 100), event };

            if (!this.ready || !this.send({ type: "ack", ...chunk })) {
                this.pendingAcks.push(chunk);
            }
        }
    }

    private open(): void {
        this.options.handlers.onStateChange("connecting");

        let socket: WebSocket;

        try {
            socket = new this.options.WebSocket(this.options.url);
        } catch {
            this.scheduleReconnect();

            return;
        }

        this.socket = socket;

        socket.onopen = () => {
            this.send({ type: "auth", device_token: this.options.deviceToken });
        };

        socket.onmessage = (event: MessageEvent) => {
            this.handleFrame(typeof event.data === "string" ? event.data : "");
        };

        socket.onclose = () => {
            if (this.socket !== socket) {
                return;
            }

            this.socket = null;
            this.ready = false;
            this.clearTimers();

            if (!this.stopped) {
                this.scheduleReconnect();
            }
        };

        socket.onerror = () => {
            // onclose follows and schedules the reconnect.
        };
    }

    private handleFrame(raw: string): void {
        let frame: Record<string, unknown>;

        try {
            frame = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return;
        }

        switch (frame.type) {
            case "ready":
                this.ready = true;
                this.attempt = 0;
                this.startPinging();
                this.flushAcks();
                this.options.handlers.onStateChange("ready");
                this.options.handlers.onReady();
                break;
            case "message":
                if (frame.message !== null && typeof frame.message === "object") {
                    this.options.handlers.onMessage(frame.message as Record<string, unknown>);
                }
                break;
            case "ping":
                this.send({ type: "pong" });
                break;
            case "error":
                if (frame.error === "device_token_invalid" || frame.error === "auth_required") {
                    this.stopped = true;
                    this.clearTimers();
                    this.options.handlers.onUnauthorized();
                }
                break;
        }
    }

    private send(frame: Record<string, unknown>): boolean {
        if (this.socket === null || this.socket.readyState !== 1) {
            return false;
        }

        try {
            this.socket.send(JSON.stringify(frame));

            return true;
        } catch {
            return false;
        }
    }

    private flushAcks(): void {
        const pending = this.pendingAcks.splice(0);

        for (const chunk of pending) {
            if (!this.send({ type: "ack", ...chunk })) {
                this.pendingAcks.push(chunk);
            }
        }
    }

    private startPinging(): void {
        this.pingTimer = setInterval(() => this.send({ type: "ping" }), this.options.pingIntervalMs);
    }

    private scheduleReconnect(): void {
        this.options.handlers.onStateChange("connecting");

        const ceiling = Math.min(this.options.maxReconnectMs, this.options.minReconnectMs * 2 ** this.attempt);
        const delay = ceiling / 2 + Math.random() * (ceiling / 2);
        this.attempt++;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;

            if (!this.stopped) {
                this.open();
            }
        }, delay);
    }

    private clearTimers(): void {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.pingTimer !== null) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }
}
