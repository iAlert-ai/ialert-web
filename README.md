# ialert-web

iAlert Web SDK. It registers the browser as a `web` device of your app and receives notifications while the page is open, over iAlert's own channel: a WebSocket to the iAlert Gateway, plus the device Inbox for anything sent while the page was closed. Each notification reaches your listeners once, across both channels and page loads.

## Install

```bash
npm install ialert-web
```

## Quick start

1. Copy `node_modules/ialert-web/service-worker.js` to your site's root as `/ialert-sw.js` (browsers only allow a service worker from your own origin).
2. Add one line:

```ts
import { IAlert } from "ialert-web";

const ialert = IAlert.init({ publicKey: "ia_pk_live_…", externalUserId: "user-42" });
```

That is all. `init()` registers the browser, connects to the Gateway, syncs the Inbox and turns on Web Push: silently when notifications are already allowed, otherwise with the permission prompt on the user's first click or key press (`promptOnInteraction: false` to call `enableWebPush()` yourself). Notifications then arrive:

- with the site closed, through Web Push;
- with a tab open, over the Gateway, shown as system notifications while the tab is in the background (also when Web Push servers are unreachable during an outage; `showNotificationsWhenHidden: false` to turn off);
- missed ones from the Inbox on the next visit, each exactly once.

Browsers play their own notification sound; a message sent with `"sound": "none"` shows silently.

Listen with `ialert.onMessage(…)` if the page should react too; `await ialert.ready` waits for the first registration.

## Usage (manual)

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

It asks for permission, subscribes with the app's VAPID key (fetched from iAlert), and registers the subscription. Pushes then show as system notifications even when no tab is open. When a tab is open, the service worker also passes the message to `onMessage` (`source: "push"`), deduplicated against the Gateway and Inbox, and a click on the notification is acknowledged as `clicked`. Send the notification with `url` to choose what a click opens (default `/`): a page of your site is opened in the open tab, another site or an app link in a new window. `IAlertMessage.url` has it for `onMessage` listeners; older messages with `data.url` work the same way.

Without Web Push, the SDK keeps working as before: messages arrive over the Gateway while the page is open and from the Inbox on the next visit.

## Sender name and photo

A message with a `sender` (`{ "id", "name", "avatar" }`) is shown with the sender's name as the title and the photo as the notification icon, both by the service worker and while the page is open. Nothing to set up. `message.sender` carries it in code.

## Auth Push (approve a sign-in on the phone)

When your server creates an Auth Push request (`POST /v1/auth-requests`), every device of that user gets a high-priority push. Show your own approve/deny screen and answer with the device's token:

```ts
ialert.onMessage(async (message) => {
    const request = authRequestOf(message); // null for other messages
    if (!request) return;
    const ok = window.confirm(`Sign in from ${request.context.city ?? "a new device"}?`);
    const code = ok && request.numberMatching ? window.prompt("Type the number shown on the sign-in page") ?? undefined : undefined;
    await ialert.respondToAuthRequest(request.id, ok, code); // "approved" | "denied"
});
```

With number matching, the user types the two-digit number shown on your sign-in page; a wrong number denies the request. An unknown or expired request throws without clearing the device registration.

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
