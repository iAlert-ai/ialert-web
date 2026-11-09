import { IAlertError } from "./errors.ts";
import type { AckEvent, Device } from "./types.ts";

type Fetch = typeof globalThis.fetch;

export interface InboxEntry {
    id: string;
    content: { title: string | null; body: string | null; image: string | null; data: Record<string, unknown> | unknown[] | null };
    collapse_id: string | null;
    delivered_at: string | null;
    read_at: string | null;
    clicked_at: string | null;
    created_at: string;
}

interface InboxPage {
    data: InboxEntry[];
    links?: { next?: string | null };
}

/** Thin REST client for the public-key endpoints of API v1. */
export class ApiClient {
    private readonly baseUrl: string;
    private readonly publicKey: string;
    private readonly fetchFn: Fetch;

    constructor(baseUrl: string, publicKey: string, fetchFn: Fetch) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.publicKey = publicKey;
        this.fetchFn = fetchFn;
    }

    register(body: Record<string, unknown>): Promise<{ data: Device; device_token: string }> {
        return this.request("POST", "/devices", body);
    }

    async update(deviceId: string, deviceToken: string, body: Record<string, unknown>): Promise<Device> {
        return (await this.request<{ data: Device }>("PATCH", `/devices/${encodeURIComponent(deviceId)}`, body, deviceToken)).data;
    }

    async unsubscribe(deviceId: string, deviceToken: string): Promise<Device> {
        return (await this.request<{ data: Device }>("POST", `/devices/${encodeURIComponent(deviceId)}/unsubscribe`, undefined, deviceToken)).data;
    }

    /** Every Inbox page (newest first), following `links.next`, up to `maxPages`. */
    async inbox(deviceId: string, deviceToken: string, unreadOnly: boolean, maxPages = 5): Promise<InboxEntry[]> {
        const entries: InboxEntry[] = [];
        let url: string | null = `${this.baseUrl}/devices/${encodeURIComponent(deviceId)}/inbox?per_page=100${unreadOnly ? "&unread=1" : ""}`;

        for (let page = 0; url !== null && page < maxPages; page++) {
            const result: InboxPage = await this.request<InboxPage>("GET", url, undefined, deviceToken);
            entries.push(...result.data);
            url = result.links?.next ?? null;
        }

        return entries;
    }

    async ack(deviceId: string, deviceToken: string, ids: string[], event: AckEvent): Promise<number> {
        let acknowledged = 0;

        for (let start = 0; start < ids.length; start += 100) {
            const result = await this.request<{ acknowledged: number }>(
                "POST",
                `/devices/${encodeURIComponent(deviceId)}/inbox/ack`,
                { ids: ids.slice(start, start + 100), event },
                deviceToken,
            );
            acknowledged += result.acknowledged;
        }

        return acknowledged;
    }

    private async request<T>(method: string, pathOrUrl: string, body?: unknown, deviceToken?: string): Promise<T> {
        const headers: Record<string, string> = {
            Accept: "application/json",
            Authorization: `Bearer ${this.publicKey}`,
        };

        if (body !== undefined) {
            headers["Content-Type"] = "application/json";
        }

        if (deviceToken !== undefined) {
            headers["X-Device-Token"] = deviceToken;
        }

        const url = pathOrUrl.startsWith("http") ? pathOrUrl : this.baseUrl + pathOrUrl;
        let response: Response;

        try {
            response = await this.fetchFn(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        } catch (error) {
            throw new IAlertError(0, "network_error", error instanceof Error ? error.message : "Network error");
        }

        const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;

        if (!response.ok) {
            throw new IAlertError(
                response.status,
                typeof payload?.code === "string" ? payload.code : "server_error",
                typeof payload?.message === "string" ? payload.message : `HTTP ${response.status}`,
                payload?.errors as Record<string, string[]> | undefined,
            );
        }

        return payload as T;
    }
}
