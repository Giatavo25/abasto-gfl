// Service Worker: guarda la interfaz para que abra rápido y sin señal.
// Los datos van por Firebase (que tiene su propio caché offline).
const CACHE = "abasto-gfl-v4";
const ARCHIVOS = ["./", "./index.html", "./styles.css", "./script.js", "./logo.jpg", "./logo-icono.png", "./manifest.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS)));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))));
  self.clients.claim();
});
// Red primero (para recibir actualizaciones), caché si no hay internet
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copia = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copia));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
