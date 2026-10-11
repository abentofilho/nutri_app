// Service worker: deixa o app instalável e abrindo mesmo sem internet.
// Estratégia "rede primeiro": sempre tenta a versão mais nova do site e só usa
// a cópia guardada quando está offline. Assim uma atualização publicada no
// GitHub Pages chega na hora para todo mundo. A API (outro domínio) nunca
// passa por aqui.

const CACHE = 'nutriapp-v2.2';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './js/app.js',
  './js/api.js',
  './js/config.js',
  './js/foods.js',
  './js/github.js',
  './js/icons.js',
  './js/label-reader.js',
  './js/nutrition.js',
  './js/privacy.js',
  './js/pwa.js',
  './js/scanner.js',
  './js/share.js',
  './js/store.js',
  './js/ui.js',
  './js/util.js',
  './js/sheets/picker.js',
  './js/sheets/product.js',
  './js/sheets/qty.js',
  './js/sheets/recipe.js',
  './js/views/admin.js',
  './js/views/history.js',
  './js/views/pantry.js',
  './js/views/profile.js',
  './js/views/recipes.js',
  './js/views/today.js',
  './js/views/welcome.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (request.method !== 'GET' || (!sameOrigin && !fonts)) return;

  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })
        .then((hit) => hit || (request.mode === 'navigate' ? caches.match('./index.html') : Response.error()))),
  );
});
