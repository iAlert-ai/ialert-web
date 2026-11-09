# @ialert/web

iAlert Web SDK. It registers the browser as a `web` device of your app and receives notifications while the page is open, over iAlert's own channel: a WebSocket to the iAlert Gateway, plus the device Inbox for anything sent while the page was closed. Each notification reaches your listeners once, across both channels and page loads.

Browser Web Push (VAPID, notifications while the site is closed) is not available yet; it will be added to this SDK without changing the API below.

```ts
import { IAlert } from "@ialert/web";

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

## Development

```bash
npm install
npm test        # node --test, no browser needed
npm run typecheck
npm run build   # dist/
```

API reference: `docs/api-v1.md` in the iAlert server repository.
