self.addEventListener("install", e => {
  e.waitUntil(
    caches.open("lockin-cache").then(cache => {
      return cache.addAll([
        "./",
        "./index.html",
        "./manifest.json",
        "./icon.png"
      ])
    })
  )
});

self.addEventListener("fetch", e => {
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open("lockin-cache").then(cache => {
          cache.put(e.request, copy);
        });
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('./index.html')
  );
});
