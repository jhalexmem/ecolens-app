// Minimal service worker. It exists almost entirely to satisfy Chrome/
// Edge's PWA installability criteria, which require a registered service
// worker with a fetch event listener before showing the "Install" prompt.
//
// Deliberately does NOT cache anything. EcoLens's sensor/AQI/weather data
// must always be fresh, and caching API responses here would risk showing
// stale readings. Every request is just passed straight through to the
// network, unchanged.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
