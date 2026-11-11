# Changelog

## 0.3.0

- Auth Push: `respondToAuthRequest` approves or denies a sign-in request on this device (with the typed number for number matching), and a helper reads the request a message carries.
- A 404 for an unknown request no longer clears the device registration (Web).

## 0.2.0

- Web Push: `enableWebPush()` subscribes the browser with the app's VAPID key and registers it, so notifications arrive while the site is closed. `service-worker.js` shows them and forwards pushes and clicks to open pages (`source: "push"`, deduplicated; clicks acked).
- The Gateway-only registration is retired when Web Push replaces it.

## 0.1.0

- First release: device registration with a public key, tags and external user id, a live connection to the iAlert Gateway over WebSocket with reconnect, Inbox sync after each connect, delivered/read/clicked acknowledgements and message de-duplication.
- Licensed under Apache 2.0.
