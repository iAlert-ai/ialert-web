# Changelog

## 0.6.0

- A message with a `sender` shows the sender's name as the title and the photo as the icon (service worker and in-page notifications). `IAlertMessage.sender` / `IAlertSender`.

## 0.5.0

- Notification links: `IAlertMessage.url` (falling back to `data.url`). A click on a Web Push notification navigates the open tab to a page of the site, or opens another site in a new window; a notification shown without a service worker opens it too.
- Registration sends a stable `installation_id`, so the Gateway-only device and the Web Push device of a browser are one device.

## 0.4.0

- `IAlert.init()`: one-line setup that registers, connects and turns on Web Push (silently when allowed, else on the first user interaction).
- Gateway and Inbox messages show as system notifications while the tab is hidden.
- `message.sound`; `"none"` shows notifications silently (service worker and hidden tabs).

## 0.3.0

- Auth Push: `respondToAuthRequest` approves or denies a sign-in request on this device (with the typed number for number matching), and a helper reads the request a message carries.
- A 404 for an unknown request no longer clears the device registration (Web).

## 0.2.0

- Web Push: `enableWebPush()` subscribes the browser with the app's VAPID key and registers it, so notifications arrive while the site is closed. `service-worker.js` shows them and forwards pushes and clicks to open pages (`source: "push"`, deduplicated; clicks acked).
- The Gateway-only registration is retired when Web Push replaces it.

## 0.1.0

- First release: device registration with a public key, tags and external user id, a live connection to the iAlert Gateway over WebSocket with reconnect, Inbox sync after each connect, delivered/read/clicked acknowledgements and message de-duplication.
- Licensed under Apache 2.0.
