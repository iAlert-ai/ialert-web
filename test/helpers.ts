import { MemoryStorage } from "../src/index.ts";

export interface RecordedRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
}

type Responder = (request: RecordedRequest) => { status?: number; body: unknown } | undefined;

/** fetch double that records requests and answers from a list of responders. */
export function fakeFetch(...responders: Responder[]) {
    const requests: RecordedRequest[] = [];

    const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const request: RecordedRequest = {
            method: init?.method ?? "GET",
            url: String(url),
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        };
        requests.push(request);

        for (const responder of responders) {
            const answer = responder(request);

            if (answer !== undefined) {
                return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
            }
        }

        return new Response(JSON.stringify({ message: "Not found", code: "not_found" }), { status: 404 });
    };

    return { fetch: fetch as typeof globalThis.fetch, requests };
}

export const registerResponder: Responder = (request) =>
    request.method === "POST" && request.url.endsWith("/devices")
        ? { status: 201, body: { data: { id: "dev_1", platform: "web", tags: {} }, device_token: "ia_dt_dev_1.sig" } }
        : undefined;

export function inboxResponder(entries: unknown[]): Responder {
    return (request) => (request.method === "GET" && request.url.includes("/inbox") ? { body: { data: entries, links: { next: null } } } : undefined);
}

export const ackResponder: Responder = (request) =>
    request.url.endsWith("/inbox/ack") ? { body: { acknowledged: (request.body as { ids: string[] }).ids.length } } : undefined;

/** WebSocket double driven by the test. */
export class FakeSocket {
    static instances: FakeSocket[] = [];
    readonly url: string;
    readyState = 0;
    sent: Record<string, unknown>[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(url: string) {
        this.url = url;
        FakeSocket.instances.push(this);
    }

    send(data: string): void {
        this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }

    close(): void {
        this.readyState = 3;
        this.onclose?.();
    }

    serverOpen(): void {
        this.readyState = 1;
        this.onopen?.();
    }

    serverSend(frame: unknown): void {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }

    serverDrop(): void {
        this.readyState = 3;
        this.onclose?.();
    }
}

export function inboxEntry(id: string, deliveredAt: string | null = null) {
    return {
        id,
        content: { title: `title ${id}`, body: "body", image: null, data: { order: 1 } },
        collapse_id: null,
        delivered_at: deliveredAt,
        read_at: null,
        clicked_at: null,
        created_at: "2026-11-09T08:00:00+00:00",
    };
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

export const newStorage = () => new MemoryStorage();
