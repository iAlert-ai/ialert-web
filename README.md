# ialert-web

iAlert Web SDK. It registers the browser as a `web` device of your app and receives notifications while the page is open, over iAlert's own channel: a WebSocket to the iAlert Gateway, plus the device Inbox for anything sent while the page was closed. Each notification reaches your listeners once, across both channels and page loads.

## Install

```bash
npm install ialert-web
```

## Usage

```ts
import { IAlert } from "ialert-web";

const ialert = new IAlert({ publicKey: "ia_pk_live_…" });

ialert.onMessage((message) => {
    showToast(message.title, message.body, message.data);
});

await ialert.register({ externalUserId: "user-42", tags: { plan: "gold" } });

// later
await ialert.setTags({ plan: "silver", trial: null }); // merged; null removes
await ialert.ack([message.id], "clicked");
await ialert.unsubscribe();
```

- Use the app's **public** key (`ia_pk_…`); the constructor refuses secret keys.
- `register()` is safe on every page load: a stable per-browser installation id maps to the same device.
- Messages are acknowledged as `delivered` automatically (`autoAckDelivered: false` to turn off). Report `read` / `clicked` yourself.
- Options: `apiUrl`, `gatewayUrl`, `storage` (defaults to `localStorage`, memory when blocked), `fetch`, `WebSocket`, `autoConnect`.
- `onConnectionStateChange(state)` reports `connecting` / `ready` / `closed`.

## Web Push (notifications while the site is closed)

1. In the iAlert panel, open the app's **APNs / FCM / Web** page and press **Generate keys** under Web Push.
2. Copy `node_modules/ialert-web/service-worker.js` to your site so it is served from your origin, for example as `/ialert-sw.js` (a service worker only controls its own origin).
3. Call `enableWebPush()` from a click, since browsers only show the permission prompt for a user gesture:

```ts
button.addEventListener("click", async () => {
    try {
        await ialert.enableWebPush({ serviceWorkerUrl: "/ialert-sw.js", register: { externalUserId: "user-42" } });
    } catch (error) {
        // error.code: permission_denied | web_push_not_configured | web_push_unsupported
    }
});
```

It asks for permission, subscribes with the app's VAPID key (fetched from iAlert), and registers the subscription. Pushes then show as system notifications even when no tab is open. When a tab is open, the service worker also passes the message to `onMessage` (`source: "push"`), deduplicated against the Gateway and Inbox, and a click on the notification is acknowledged as `clicked`. Set `data.url` on the notification to choose the page a click opens (default `/`).

Without Web Push, the SDK keeps working as before: messages arrive over the Gateway while the page is open and from the Inbox on the next visit.

## Development

```bash
npm install
npm test        # node --test, no browser needed
npm run typecheck
npm run build   # dist/
```

API reference: `docs/api-v1.md` in the iAlert server repository.

## License

Copyright 2026 iAlert.ir

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE).
