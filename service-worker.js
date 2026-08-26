// Service worker BHB — cache-first pour les fichiers de l'app,
// pour que tout fonctionne même sans connexion.

const CACHE_NAME = 'bhb-cache-v1';
const FICHIERS_A_CACHER = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './idb.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FICHIERS_A_CACHER))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((noms) =>
      Promise.all(
        noms.filter((nom) => nom !== CACHE_NAME).map((nom) => caches.delete(nom))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Cache-first : sert le fichier en cache s'il existe, sinon va sur le réseau
  // et met en cache pour la prochaine fois hors ligne.
  event.respondWith(
    caches.match(event.request).then((reponseEnCache) => {
      if (reponseEnCache) return reponseEnCache;
      return fetch(event.request)
        .then((reponseReseau) => {
          if (event.request.method === 'GET' && reponseReseau.ok) {
            const clone = reponseReseau.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return reponseReseau;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
