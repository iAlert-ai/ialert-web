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
            // A message with a sender reads like a chat message: the sender's name and photo.
            const sender = message.sender && message.sender.name ? message.sender : null;
            await self.registration.showNotification(sender ? sender.name : message.title || message.body || "", {
                body: sender ? message.body || message.title || "" : message.title ? message.body || "" : "",
                icon: (sender && sender.avatar) || undefined,
                image: message.image || undefined,
                tag: message.collapse_id || message.id,
                silent: message.sound === "none",
                data: { ialert: message },
            });
        })(),
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const message = (event.notification.data && event.notification.data.ialert) || {};
    // `url` (or `data.url` of older messages): a page of this site, another site, or an app deep link.
    const link = (typeof message.url === "string" && message.url) || (message.data && typeof message.data.url === "string" && message.data.url) || null;
    const url = link && !/^(javascript|data|file|blob):/i.test(link) ? link : null;

    event.waitUntil(
        (async () => {
            const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
            const target = windows.find((client) => "focus" in client);
            const sameOrigin = url !== null && new URL(url, self.location.origin).origin === self.location.origin;

            if (target && (url === null || sameOrigin)) {
                const focused = await target.focus();
                const client = url !== null && "navigate" in focused ? (await focused.navigate(new URL(url, self.location.origin).href).catch(() => null)) || focused : focused;
                client.postMessage({ type: "ialert:click", id: message.id });

                return;
            }

            if (target) {
                target.postMessage({ type: "ialert:click", id: message.id });
            }

            const opened = await self.clients.openWindow(url || "/");

            if (opened) {
                opened.postMessage({ type: "ialert:click", id: message.id });
            }
        })(),
    );
});
