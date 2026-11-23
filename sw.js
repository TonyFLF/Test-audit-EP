/* Audit EP – service worker
   1) met l'application en cache pour qu'elle s'ouvre sans réseau ;
   2) sert les fonds de carte téléchargés (cache « audit-ep-tiles-v1 », rempli par l'appli : même nom que dans js/app.js).
   Pour forcer la mise à jour du cache de l'appli après une modification, change simplement VERSION. */
const VERSION = 'v2';
const SHELL_CACHE = 'audit-ep-shell-' + VERSION;
const TILE_CACHE = 'audit-ep-tiles-v1';
const SHELL_FILES = [
  './', 'index.html', 'css/style.css', 'js/app.js', 'manifest.json',
  'lib/leaflet.js', 'lib/leaflet.css', 'lib/leaflet.markercluster.js',
  'lib/MarkerCluster.css', 'lib/MarkerCluster.Default.css', 'lib/proj4.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const TILE_HOSTS = /(^|\.)(tile\.openstreetmap\.org|arcgisonline\.com|data\.geopf\.fr)$/;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => Promise.all(SHELL_FILES.map((f) => c.add(f).catch(() => null)))) // un fichier absent n'empêche pas l'installation
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('audit-ep-shell') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function tileFromCache(req) {
  const cache = await caches.open(TILE_CACHE);
  let hit = await cache.match(req.url);
  if (hit) return hit;
  // OpenStreetMap répartit les tuiles sur a./b./c. : on essaie les trois
  const m = req.url.match(/^(https:\/\/)([abc])(\.tile\.openstreetmap\.org\/.*)$/);
  if (m) for (const s of ['a', 'b', 'c']) { hit = await cache.match(m[1] + s + m[3]); if (hit) return hit; }
  return null;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Fonds de carte : tuiles téléchargées d'abord, sinon réseau
  if (TILE_HOSTS.test(url.hostname)) {
    e.respondWith(tileFromCache(req).then((hit) => hit || fetch(req)));
    return;
  }

  // Fichiers de l'appli (même origine) : réseau d'abord (toujours à jour), cache si hors-ligne
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) { const copy = res.clone(); caches.open(SHELL_CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
    );
  }
  // Tout le reste (Google Sheets/Apps Script, Drive, polices) : laissé au navigateur
});
