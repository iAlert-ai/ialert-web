import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { IAlert, IAlertError, type IAlertMessage } from "../src/index.ts";
import { FakeSocket, ackResponder, fakeFetch, flush, inboxEntry, inboxResponder, newStorage, registerResponder } from "./helpers.ts";

const PUBLIC_KEY = "ia_pk_live_abcdefghijkl_secret";

beforeEach(() => {
    FakeSocket.instances = [];
});

function sdk(fetch: typeof globalThis.fetch, storage = newStorage(), extra = {}) {
    return new IAlert({
        publicKey: PUBLIC_KEY,
        apiUrl: "https://api.test/api/v1",
        gatewayUrl: "wss://gw.test/v1/connect",
        fetch,
        storage,
        WebSocket: FakeSocket as unknown as new (url: string) => WebSocket,
        ...extra,
    });
}

describe("registration", () => {
    it("refuses secret keys", () => {
        assert.throws(() => new IAlert({ publicKey: "ia_sk_live_x" }), (error: IAlertError) => error.code === "invalid_public_key");
    });

    it("registers as a web device with a stable installation id and the public key", async () => {
        const { fetch, requests } = fakeFetch(registerResponder);
        const storage = newStorage();

        await sdk(fetch, storage, { autoConnect: false }).register({ externalUserId: "user-42", tags: { plan: "gold" } });
        await sdk(fetch, storage, { autoConnect: false }).register();

        const [first, second] = requests;
        const body = first?.body as Record<string, unknown>;
        assert.equal(first?.headers.Authorization, `Bearer ${PUBLIC_KEY}`);
        assert.equal(body.platform, "web");
        assert.match(String(body.push_token), /^ia_web_[0-9a-f-]{36}$/);
        assert.equal(body.external_user_id, "user-42");
        assert.deepEqual(body.tags, { plan: "gold" });
        assert.equal(body.sdk_version, "0.1.0");
        assert.equal((second?.body as Record<string, unknown>).push_token, body.push_token);
    });

    it("rejects invalid tag keys before calling the api", async () => {
        const { fetch, requests } = fakeFetch(registerResponder);

        await assert.rejects(sdk(fetch).register({ tags: { "bad key": 1 } }), (error: IAlertError) => error.code === "invalid_tag_key");
        assert.equal(requests.length, 0);
    });

    it("updates its own device with the device token", async () => {
        const { fetch, requests } = fakeFetch(registerResponder, (request) =>
            request.method === "PATCH" ? { body: { data: { id: "dev_1", tags: { plan: "gold" } } } } : undefined,
        );
        const ialert = sdk(fetch, newStorage(), { autoConnect: false });
        await ialert.register();

        await ialert.setTags({ plan: "gold", old: null });

        const patch = requests.at(-1);
        assert.equal(patch?.url, "https://api.test/api/v1/devices/dev_1");
        assert.equal(patch?.headers["X-Device-Token"], "ia_dt_dev_1.sig");
        assert.deepEqual(patch?.body, { tags: { plan: "gold", old: null } });
    });

    it("forgets the registration when the device token is rejected", async () => {
        const { fetch } = fakeFetch(registerResponder, (request) =>
            request.method === "PATCH" ? { status: 403, body: { message: "Invalid", code: "device_token_invalid" } } : undefined,
        );
        const ialert = sdk(fetch, newStorage(), { autoConnect: false });
        await ialert.register();

        await assert.rejects(ialert.setExternalUserId("u"), (error: IAlertError) => error.status === 403 && error.code === "device_token_invalid");
        assert.equal(ialert.deviceId, null);
    });
});

describe("gateway", () => {
    it("authenticates, answers pings and delivers each message once with an ack", async () => {
        const { fetch } = fakeFetch(registerResponder, inboxResponder([]), ackResponder);
        const ialert = sdk(fetch);
        const received: IAlertMessage[] = [];
        ialert.onMessage((message) => received.push(message));
        await ialert.register();

        const socket = FakeSocket.instances[0]!;
        assert.equal(socket.url, "wss://gw.test/v1/connect");
        socket.serverOpen();
        assert.deepEqual(socket.sent[0], { type: "auth", device_token: "ia_dt_dev_1.sig" });

        socket.serverSend({ type: "ready" });
        socket.serverSend({ type: "ping" });
        const message = { id: "n_1", title: "Hi", body: "There", image: null, data: { a: 1 }, collapse_id: null, priority: "high", created_at: null };
        socket.serverSend({ type: "message", message });
        socket.serverSend({ type: "message", message });
        await flush();

        assert.equal(received.length, 1);
        assert.equal(received[0]?.source, "gateway");
        assert.deepEqual(received[0]?.data, { a: 1 });
        assert.deepEqual(socket.sent.slice(1), [{ type: "pong" }, { type: "ack", ids: ["n_1"], event: "delivered" }]);
        ialert.disconnect();
    });

    it("syncs missed inbox messages after ready, oldest first, and acks the undelivered ones", async () => {
        const { fetch, requests } = fakeFetch(registerResponder, inboxResponder([inboxEntry("n_new"), inboxEntry("n_old", "2026-11-09T08:00:00+00:00")]), ackResponder);
        const ialert = sdk(fetch);
        const received: string[] = [];
        ialert.onMessage((message) => received.push(`${message.source}:${message.id}`));
        await ialert.register();

        const socket = FakeSocket.instances[0]!;
        socket.serverOpen();
        socket.serverSend({ type: "ready" });
        await flush();
        await flush();

        const inboxRequest = requests.find((request) => request.url.includes("/inbox"));
        assert.match(inboxRequest?.url ?? "", /unread=1/);
        assert.deepEqual(received, ["inbox:n_old", "inbox:n_new"]);
        assert.deepEqual(socket.sent.at(-1), { type: "ack", ids: ["n_new"], event: "delivered" });
        ialert.disconnect();
    });

    it("does not show a message again on the next page load", async () => {
        const storage = newStorage();
        const { fetch } = fakeFetch(registerResponder, inboxResponder([inboxEntry("n_1")]), ackResponder);
        const first = sdk(fetch, storage, { autoConnect: false });
        await first.register();
        assert.equal((await first.syncInbox()).length, 1);

        const second = sdk(fetch, storage, { autoConnect: false });
        assert.equal((await second.syncInbox()).length, 0);
    });

    it("acks over http when the socket is not ready", async () => {
        const { fetch, requests } = fakeFetch(registerResponder, ackResponder);
        const ialert = sdk(fetch, newStorage(), { autoConnect: false });
        await ialert.register();

        await ialert.ack(["n_1"], "clicked");

        assert.deepEqual(requests.at(-1)?.body, { ids: ["n_1"], event: "clicked" });
        assert.equal(requests.at(-1)?.headers["X-Device-Token"], "ia_dt_dev_1.sig");
    });

    it("reconnects after the socket drops but stops when the token is invalid", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
        const { fetch } = fakeFetch(registerResponder, inboxResponder([]), ackResponder);
        const ialert = sdk(fetch);
        await ialert.register();

        FakeSocket.instances[0]!.serverDrop();
        t.mock.timers.tick(60_000);
        assert.equal(FakeSocket.instances.length, 2);

        const second = FakeSocket.instances[1]!;
        second.serverOpen();
        second.serverSend({ type: "error", error: "device_token_invalid" });
        second.serverDrop();
        t.mock.timers.tick(120_000);

        assert.equal(FakeSocket.instances.length, 2);
        assert.equal(ialert.deviceId, null);
    });
});
