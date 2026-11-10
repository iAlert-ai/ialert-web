/*
 * iAlert Web Push service worker. Copy this file to your site so it is served
 * from your origin (default URL: /ialert-sw.js) and pass its URL to
 * ialert.enableWebPush({ serviceWorkerUrl }). It shows each push as a system
 * notification, tells open pages about it (the SDK dedupes it against the
 * Gateway and Inbox), and reports clicks back to the page.
 *
 * Copyright 2026 iAlert.ir. Licensed under the Apache License, Version 2.0.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
    let message = {};

    try {
        message = event.data ? event.data.json() : {};
    } catch (error) {
        message = {};
    }

    event.waitUntil(
        (async () => {
            const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

            for (const client of windows) {
                client.postMessage({ type: "ialert:message", message });
            }

            // Browsers require a visible notification for every push.
            await self.registration.showNotification(message.title || message.body || "", {
                body: message.title ? message.body || "" : "",
                image: message.image || undefined,
                tag: message.collapse_id || message.id,
                data: { ialert: message },
            });
        })(),
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const message = (event.notification.data && event.notification.data.ialert) || {};
    const url = (message.data && typeof message.data.url === "string" && message.data.url) || "/";

    event.waitUntil(
        (async () => {
            const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
            const target = windows.find((client) => "focus" in client);

            if (target) {
                await target.focus();
                target.postMessage({ type: "ialert:click", id: message.id });

                return;
            }

            const opened = await self.clients.openWindow(url);

            if (opened) {
                opened.postMessage({ type: "ialert:click", id: message.id });
            }
        })(),
    );
});
