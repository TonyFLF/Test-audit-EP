/* ════════ SOCLE ROBUSTESSE v4 ════════ */
const PHOTO_MAX_DIM = 1280;
const PHOTO_QUALITY = 0.7;
const PHOTO_TYPES = ['luminaire', 'mat', 'classe2'];

/* ---- IndexedDB ---- */
const DB = (() => {
  let _db = null;
  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('auditEP', 4);
      r.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('points'))     db.createObjectStore('points',     { keyPath: 'id' });
        if (!db.objectStoreNames.contains('photos'))     db.createObjectStore('photos',     { keyPath: 'key' });
        if (!db.objectStoreNames.contains('queue'))      db.createObjectStore('queue',      { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta'))       db.createObjectStore('meta',       { keyPath: 'k' });
        if (!db.objectStoreNames.contains('tombstones')) db.createObjectStore('tombstones', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('photoQueue')) db.createObjectStore('photoQueue', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('armoires'))   db.createObjectStore('armoires',   { keyPath: 'id' });
      };
      r.onsuccess = () => { _db = r.result; resolve(_db); };
      r.onerror = () => reject(r.error);
    });
  }
  function tx(store, mode) { return open().then((db) => db.transaction(store, mode).objectStore(store)); }
  function reqP(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }
  return {
    open,
    async put(store, val) { const s = await tx(store, 'readwrite'); return reqP(s.put(val)); },
    async get(store, key) { const s = await tx(store, 'readonly');  return reqP(s.get(key)); },
    async del(store, key) { const s = await tx(store, 'readwrite'); return reqP(s.delete(key)); },
    async all(store) { const s = await tx(store, 'readonly'); return reqP(s.getAll()); },
    async count(store) { const s = await tx(store, 'readonly'); return reqP(s.count()); },
    async keys(store) { const s = await tx(store, 'readonly'); return reqP(s.getAllKeys()); },
    async putAllPoints(points) {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('points', 'readwrite');
        const s = t.objectStore('points');
        points.forEach((p) => s.put(p));
        t.oncomplete = () => res(true);
        t.onerror = () => rej(t.error);
      });
    }
  };
})();

/* ---- Photos : redimensionnement → Blob (fini le base64 dans localStorage) ---- */
function downscaleToBlob(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.width, h = img.height;
      const scale = Math.min(1, PHOTO_MAX_DIM / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob null'))), 'image/jpeg', PHOTO_QUALITY);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load')); };
    img.src = url;
  });
}
async function savePhotoBlob(pointId, type, blob) { return DB.put('photos', { key: pointId + '__' + type, pointId, type, blob }); }
async function getPhotoBlob(pointId, type) { const r = await DB.get('photos', pointId + '__' + type); return r ? r.blob : null; }

/* ---- File de sync persistée (survit à une fermeture de l'app) ---- */
async function enqueuePoint(pt) { try { await DB.put('queue', { id: pt.id, pt: pt, ts: Date.now() }); } catch (e) { console.error(e); } }

/* ---- Barre d'état & diagnostic ---- */
let _storageWarn = false;
function setStorageWarn(on) { _storageWarn = on; updateStatus(); }
async function updateStatus() {
  const pill = document.getElementById('status-pill');
  const txt = document.getElementById('status-text');
  if (!pill || !txt) return;
  let pending = 0;
  try { pending = await DB.count('queue'); } catch (e) {}
  try { pending += await DB.count('photoQueue'); } catch (e) {}
  pill.classList.toggle('offline', !navigator.onLine);
  pill.classList.toggle('warn', _storageWarn);
  const net = navigator.onLine ? 'En ligne' : 'Hors ligne';
  txt.innerHTML = _storageWarn ? '⚠ stockage'
    : (pending > 0 ? net + ' · <span class="pend">' + pending + ' à sync</span>' : net);
  const dg = document.getElementById('diag');
  if (dg && dg.classList.contains('show')) refreshDiag();
}
let _diagTimer = null, _diagBusy = false;
function openDiag() {
  refreshDiag();
  document.getElementById('diag').classList.add('show');
  if (_diagTimer) clearInterval(_diagTimer);
  _diagTimer = setInterval(refreshDiag, 3000);   // les compteurs restent à jour tant que la fenêtre est ouverte
}
function closeDiag() {
  document.getElementById('diag').classList.remove('show');
  if (_diagTimer) { clearInterval(_diagTimer); _diagTimer = null; }
}
async function refreshDiag() {
  if (_diagBusy) return;
  _diagBusy = true;
  try {
    const set = (id, v, cls) => { const el = document.getElementById(id); if (el) { el.textContent = v; el.className = 'v' + (cls ? ' ' + cls : ''); } };
    set('d-net', navigator.onLine ? 'En ligne' : 'Hors ligne', navigator.onLine ? 'ok' : 'warn');
    // Écrit d'abord les modifications en attente (débounce 400 ms) : le compteur reflète ce qui est réellement sur l'appareil
    if (_saveTimer) { clearTimeout(_saveTimer); _saveLocalNow(); }
    const mine = x => !state.chantier || String((x && x.chantier) || '') === String(state.chantier);
    let ptsAll = null, armsAll = [];
    try { ptsAll = await DB.all('points'); } catch (e) {}
    try { armsAll = await DB.all('armoires'); } catch (e) {}
    const surAppareil = (n, tot) => n === tot ? String(n) : (n + ' · ' + tot + ' sur l\u2019appareil');
    if (ptsAll) set('d-points', surAppareil(ptsAll.filter(mine).length, ptsAll.length)); else set('d-points', '—');
    try {
      const ids = new Set();
      (ptsAll || []).filter(mine).forEach(p => ids.add(String(p.id)));
      armsAll.filter(mine).forEach(a => ids.add(String(a.id)));
      const keys = await DB.keys('photos');
      let n = 0;
      keys.forEach(k => { const s = String(k); const i = s.lastIndexOf('__'); if (i > 0 && ids.has(s.slice(0, i))) n++; });
      set('d-photos', surAppareil(n, keys.length));
    } catch (e) { set('d-photos', '—'); }
    try {
      const q = await DB.count('queue');
      let pq = 0; try { pq = await DB.count('photoQueue'); } catch (e2) {}
      const tot = q + pq;
      set('d-queue', tot === 0 ? '0 ✓' : (String(tot) + (pq ? ' (dont ' + pq + ' photos)' : '')), tot === 0 ? 'ok' : 'warn');
      const busy = isSyncing || isLoading || isUploadingPhotos;
      if (busy) set('d-sync', 'En cours…', '');
      else if (!navigator.onLine) set('d-sync', 'Hors ligne', 'warn');
      else if (tot > 0) set('d-sync', 'En attente', 'warn');
      else set('d-sync', 'À jour ✓', 'ok');
    } catch (e) { set('d-queue', '—'); set('d-sync', '—'); }
    set('d-photoerr', lastPhotoError || '—', lastPhotoError ? 'warn' : 'ok');
    try { const c = await caches.open(TILE_CACHE_NAME); const k = await c.keys(); set('d-tiles', String(k.length)); } catch (e) { set('d-tiles', '—'); }
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        set('d-storage', (est.usage / 1048576).toFixed(1) + ' / ' + (est.quota / 1048576).toFixed(0) + ' Mo');
      } else set('d-storage', 'n/d');
    } catch (e) { set('d-storage', '—'); }
    try {
      const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
      set('d-persist', persisted ? 'Oui ✓' : 'Non garanti', persisted ? 'ok' : 'warn');
    } catch (e) {}
  } finally { _diagBusy = false; }
}

/* ---- Pré-cache des tuiles de la zone visible (À FAIRE EN RÉSEAU, avant le terrain) ---- */
function lon2tile(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function lat2tile(lat, z) { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z)); }
// Doit reproduire EXACTEMENT l'algorithme de Leaflet (TileLayer._getSubdomain) :
// sinon les tuiles préchargées sous "a." ne correspondent jamais aux requêtes
// réelles faites sous "b." ou "c." une fois hors ligne → trous sur la carte.
const TILE_SUBDOMAINS = ['a', 'b', 'c'];
function tileSubdomain(x, y) { return TILE_SUBDOMAINS[Math.abs(x + y) % TILE_SUBDOMAINS.length]; }
function precacheTileUrl(z, x, y) {
  if (baseMode === 1) return 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&TILEMATRIX=' + z + '&TILEROW=' + y + '&TILECOL=' + x;
  if (baseMode === 2) return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + z + '/' + y + '/' + x;
  return 'https://' + tileSubdomain(x, y) + '.tile.openstreetmap.org/' + z + '/' + x + '/' + y + '.png';
}
async function precacheVisibleArea() {
  if (!map) return;
  if (!navigator.onLine) { showToast('Préchargement impossible hors réseau', 'error'); return; }
  const b = map.getBounds();
  // Du zoom actuel JUSQU'AU zoom terrain (19) : indispensable pour repérer les mâts de près hors ligne.
  const z0 = Math.max(14, Math.round(map.getZoom()));
  const zMaxCap = (baseMode === 2) ? 18 : 19;   // Esri : pas de tuiles au-delà de 18
  const fondNom = baseMode === 1 ? 'Satellite IGN' : (baseMode === 2 ? 'Satellite Esri' : 'Plan');
  const zooms = [];
  for (let z = z0; z <= zMaxCap; z++) zooms.push(z);
  const urls = [];
  zooms.forEach((z) => {
    const xMin = lon2tile(b.getWest(), z), xMax = lon2tile(b.getEast(), z);
    const yMin = lat2tile(b.getNorth(), z), yMax = lat2tile(b.getSouth(), z);
    for (let x = xMin; x <= xMax; x++) for (let y = yMin; y <= yMax; y++) urls.push(precacheTileUrl(z, x, y));
  });
  if (!urls.length) { showToast('Zone vide', 'error'); return; }
  if (urls.length > 6000 && !confirm('Zone étendue : ' + urls.length + ' tuiles (jusqu\u2019au zoom terrain). Cela peut prendre quelques minutes. Zoomer sur une zone plus petite, ou confirmer ?')) return;
  const prog = document.getElementById('cache-progress');
  const bar = document.getElementById('cache-bar'), pct = document.getElementById('cache-pct'), lbl = document.getElementById('cache-lbl');
  prog.classList.add('show'); lbl.textContent = 'Préchargement carte (' + urls.length + ' tuiles)…';
  let done = 0, ok = 0; const total = urls.length || 1; let i = 0;
  // Ouvre directement le cache des tuiles pour y ÉCRIRE chaque tuile (fiable hors-ligne, iOS compris).
  let tileCache = null;
  try { tileCache = await caches.open('audit-ep-tiles-v1'); } catch (e) {}
  const loadOne = async (url) => {
    try {
      // déjà en cache ? on ne re-télécharge pas
      if (tileCache) { const hit = await tileCache.match(url); if (hit) { ok++; return; } }
      // 'cors' + tuiles servies avec en-têtes CORS (OSM/IGN/Esri le font) → réponse cachable
      // qui correspond exactement à la requête de Leaflet (crossOrigin:true).
      const resp = await fetch(url, { mode: 'cors', cache: 'no-store' });
      if (tileCache && resp && (resp.ok || resp.type === 'opaque')) { await tileCache.put(url, resp.clone()); ok++; }
    } catch (e) { /* tuile en échec : on continue */ }
  };
  const worker = async () => { while (i < urls.length) { await loadOne(urls[i++]); done++; if (done % 4 === 0 || done === total) { const p = Math.round(done / total * 100); bar.style.width = p + '%'; pct.textContent = p + ' %'; } } };
  await Promise.all(Array.from({ length: 8 }, worker));
  prog.classList.remove('show'); bar.style.width = '0%'; pct.textContent = '0 %';
  if (ok === 0) showToast('Échec du préchargement — vérifiez le réseau', 'error');
  else if (ok < total) showToast('Carte préchargée : ' + ok + '/' + total + ' tuiles (réseau instable, relancez pour compléter)', 'success');
  else showToast('Carte préchargée ✓ (' + ok + ' tuiles) — dispo hors-ligne', 'success');
  requestPersistence();
  refreshDiag();
}

/* ---- Export complet CSV (filet de sécurité local, indépendant du réseau) ---- */
function csvCell(v) { v = (v == null ? '' : String(v)); return /[",;\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function _telecharger(csvText, filename) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
async function exportAll() {
  const ch = state.chantier || '';
  const memeChantier = x => !ch || String(x.chantier || '') === String(ch);
  const suffixe = (ch || 'export').replace(/\W+/g, '_') + '_' + new Date().toISOString().slice(0, 10) + '.csv';

  // ── Points (chantier courant) ──
  let points = [];
  try { points = await DB.all('points'); } catch (e) { points = state.points || []; }
  points = points.filter(memeChantier);
  const cols = ['id', 'idArmoire', 'classePrecision', 'sourcePosition', 'gpsAccuracy', 'lat', 'lng', 'nbrSupports', 'typeSupport', 'etatSupport', 'hauteur', 'typeAttache', 'nbrLuminaires', 'typeLuminaire', 'etatLuminaire', 'technologie', 'puissance', 'observations', 'photos', 'dansPanier', 'chantier', 'technicien', 'date'];
  const lines = points.map((p) => cols.map((c) => {
    let v = p[c];
    if (c === 'photos' && v && typeof v === 'object') v = PHOTO_TYPES.filter((t) => v[t]).join(',');
    return csvCell(v);
  }).join(';'));
  _telecharger('\uFEFF' + cols.join(';') + '\n' + lines.join('\n'), 'audit_points_' + suffixe);

  // ── Armoires (chantier courant) — 2e fichier, avec un délai pour ne pas être bloqué ──
  let arms = [];
  try { arms = await DB.all('armoires'); } catch (e) { arms = state.armoires || []; }
  arms = arms.filter(memeChantier);
  if (arms.length) {
    const acols = ['id', 'etatExt', 'etatInt', 'abonnement', 'cable', 'departs', 'protection', 'horloge', 'observations', 'lat', 'lng', 'photos', 'chantier', 'technicien', 'date'];
    const alines = arms.map((r) => acols.map((c) => {
      let v = r[c];
      if (c === 'photos' && v && typeof v === 'object') v = ARM_PHOTO_TYPES.filter((t) => v[t]).join(',');
      return csvCell(v);
    }).join(';'));
    const acsv = '\uFEFF' + acols.join(';') + '\n' + alines.join('\n');
    // délai de 900 ms : évite que le navigateur (iOS surtout) bloque le 2e téléchargement
    setTimeout(() => _telecharger(acsv, 'audit_armoires_' + suffixe), 900);
  }
  showToast(points.length + ' points' + (arms.length ? ' + ' + arms.length + ' armoires (2 fichiers)' : '') + ' exportés', 'success');
}

/* ---- Export ZIP des photos (store-only, sans dépendance, fonctionne hors réseau) ---- */
const _crcTable = (() => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = _crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function _u16(n) { return new Uint8Array([n & 255, (n >>> 8) & 255]); }
function _u32(n) { return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]); }
function _cat(arrs) { let len = 0; arrs.forEach(a => len += a.length); const out = new Uint8Array(len); let o = 0; arrs.forEach(a => { out.set(a, o); o += a.length; }); return out; }
function buildZip(files) {
  const enc = new TextEncoder();
  const local = [], central = []; let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const lh = _cat([_u32(0x04034b50), _u16(20), _u16(0), _u16(0), _u16(0), _u16(0), _u32(crc), _u32(size), _u32(size), _u16(name.length), _u16(0), name]);
    local.push(lh, f.data);
    central.push(_cat([_u32(0x02014b50), _u16(20), _u16(20), _u16(0), _u16(0), _u16(0), _u16(0), _u32(crc), _u32(size), _u32(size), _u16(name.length), _u16(0), _u16(0), _u16(0), _u16(0), _u32(0), _u32(offset), name]));
    offset += lh.length + size;
  }
  let cSize = 0; central.forEach(c => cSize += c.length);
  const eocd = _cat([_u32(0x06054b50), _u16(0), _u16(0), _u16(central.length), _u16(central.length), _u32(cSize), _u32(offset), _u16(0)]);
  return new Blob([...local, ...central, eocd], { type: 'application/zip' });
}
async function exportPhotos() {
  let recs = [];
  try { recs = await DB.all('photos'); } catch (e) {}
  if (!recs.length) { showToast('Aucune photo à exporter', ''); return; }
  showToast('Préparation du ZIP photos…');
  const files = [];
  for (const r of recs) {
    try { files.push({ name: (r.pointId || 'PL') + '__' + (r.type || 'photo') + '.jpg', data: new Uint8Array(await r.blob.arrayBuffer()) }); } catch (e) {}
  }
  const zip = buildZip(files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zip);
  a.download = 'photos_' + (state.chantier || 'audit').replace(/\W+/g, '_') + '_' + new Date().toISOString().slice(0, 10) + '.zip';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 6000);
  showToast(files.length + ' photos exportées', 'success');
}

/* ---- Service worker + stockage persistant ---- */
async function registerSW() { if (!('serviceWorker' in navigator)) return; try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.error('SW', e); } }
async function requestPersistence() { try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {} }
window.addEventListener('load', () => { registerSW(); requestPersistence(); updateStatus(); });
window.addEventListener('online', updateStatus);
window.addEventListener('offline', updateStatus);
/* ════════ fin socle ════════ */

// ── STATE ──
let state = {
  technicien: '',
  chantier: '',
  points: [],
  armoires: [],
  filterArmoire: [],   // multi-sélection d'armoires (vide = toutes)
  filterChamp: null,   // { field, value } — filtre par caractéristique (null = aucun)
  currentPoint: null,
  previousScreen: 'map',
  panierInForm: false,
  photoBlobs: { luminaire: null, mat: null, classe2: null },
  photoExisting: { luminaire: false, mat: false, classe2: false },
  armoirePhotoBlobs: { arm_ext: null, arm_int: null, arm_compteur: null },
  armoirePhotoExisting: { arm_ext: false, arm_int: false, arm_compteur: false }
};
let currentGPSAccuracy = null;
let currentSourcePosition = '';

// ── PEEEPS : tout ce qui est affiché ou modifié en masse est limité au PEEEPS courant ──
function inPeeeps(x) { return !state.chantier || String((x && x.chantier) || '') === String(state.chantier); }
function peeepsPoints() { return state.points.filter(inPeeeps); }
function peeepsArmoires() { return state.armoires.filter(inPeeeps); }
function panierPoints() { return state.points.filter(p => p.dansPanier && inPeeeps(p)); }

// ── ANNULER (Ctrl+Z) — pile des dernières actions modifiant/supprimant des points ──
// Chaque entrée { id, before } où before = clone du point AVANT l'action (null si le
// point n'existait pas avant, càd l'action l'a créé → annuler = le supprimer à nouveau).
// Limité à la session en cours (non persisté) et aux N dernières actions.
const undoStack = [];
const UNDO_MAX = 20;
function cloneEntry(pt) { return pt ? JSON.parse(JSON.stringify(pt)) : null; }
const redoStack = [];
function pushUndo(label, entries) {
  undoStack.push({ label, entries, ts: Date.now() });
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;            // une nouvelle action invalide les actions « à rétablir »
  updateUndoButton();
}
function clearHistory() { undoStack.length = 0; redoStack.length = 0; updateUndoButton(); }
function updateUndoButton() {
  const maj = (btnId, cntId, stack, vide, verbe) => {
    const btn = document.getElementById(btnId), badge = document.getElementById(cntId);
    if (!btn) return;
    btn.disabled = stack.length === 0;
    if (stack.length) {
      badge.textContent = stack.length;
      badge.style.display = 'flex';
      btn.title = verbe + ' : ' + stack[stack.length - 1].label;
    } else {
      badge.style.display = 'none';
      btn.title = vide;
    }
  };
  maj('undo-btn', 'undo-count', undoStack, 'Annuler la dernière action', 'Annuler');
  maj('redo-btn', 'redo-count', redoStack, 'Rétablir l\u2019action annulée', 'Rétablir');
}
// Applique une liste { id, before } et renvoie la liste inverse (état juste avant l'application),
// ce qui permet d'annuler ET de rétablir avec le même code.
async function _applyHistory(entries) {
  const inverse = [];
  for (const entry of entries) {
    const idx = state.points.findIndex(p => p.id === entry.id);
    inverse.push({ id: entry.id, before: idx >= 0 ? cloneEntry(state.points[idx]) : null });
    if (entry.before === null) {
      // Le point n'existait pas avant cette action → on le retire à nouveau
      if (idx >= 0) state.points.splice(idx, 1);
      try { await DB.del('points', entry.id); } catch (e) {}
      try { await DB.put('tombstones', { id: entry.id, ts: Date.now() }); } catch (e) {}
      await sendDeleteToSheets('Points Lumineux', entry.id);
    } else {
      // Restaure l'état exact d'avant (coordonnées, champs modifiés, etc.)
      if (idx >= 0) state.points[idx] = entry.before; else state.points.push(entry.before);
      try { await DB.del('tombstones', entry.id); } catch (e) {} // au cas où c'était une suppression
      await syncPointToSheets(entry.before);
    }
  }
  return inverse;
}
async function _runHistory(source, target, t) {
  if (!source.length) { showToast(t.rien, ''); return; }
  const action = source.pop();
  updateUndoButton();
  const ub = document.getElementById('undo-btn'), rb = document.getElementById('redo-btn');
  if (ub) ub.disabled = true;
  if (rb) rb.disabled = true;
  showToast(t.en_cours + ' : ' + action.label + '…', '');
  try {
    const inverse = await _applyHistory(action.entries);
    target.push({ label: action.label, entries: inverse, ts: Date.now() });
    if (target.length > UNDO_MAX) target.shift();
    saveLocal();
    refreshMapMarkers(); renderList(); renderPanier(); updateStatus();
    showToast(t.fait + ' : ' + action.label + ' ✓', 'success');
  } catch (e) {
    console.error('historique', e);
    source.push(action);   // l'action reste disponible (la ré-appliquer est sans danger)
    showToast('⚠ Erreur : ' + t.verbe + ' impossible', 'error');
  } finally {
    updateUndoButton();
  }
}
function undoLast() { return _runHistory(undoStack, redoStack, { rien: 'Rien à annuler', en_cours: 'Annulation', fait: 'Annulé', verbe: 'annulation' }); }
function redoLast() { return _runHistory(redoStack, undoStack, { rien: 'Rien à rétablir', en_cours: 'Rétablissement', fait: 'Rétabli', verbe: 'rétablissement' }); }

// ── OFFLINE ──
function updateOfflineBanner() {
  document.getElementById('offline-banner').classList.toggle('show', !navigator.onLine);
}
window.addEventListener('online', updateOfflineBanner);
window.addEventListener('offline', updateOfflineBanner);
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undoLast();
  } else if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && e.key.toLowerCase() === 'z') || (!e.shiftKey && e.key.toLowerCase() === 'y'))) {
    // Rétablir : on laisse le comportement natif dans les champs de saisie
    const t = e.target && e.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || (e.target && e.target.isContentEditable)) return;
    e.preventDefault();
    redoLast();
  }
});

// ── TOAST ──
function showToast(msg, type='') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => t.className = 'toast', 2500);
}

// ── ÉCHAPPEMENT HTML (défense en profondeur) ──
// Les champs texte libres (ID armoire, observations, modification en masse…)
// transitent par le Sheet partagé entre techniciens. On échappe systématiquement
// à l'affichage pour qu'une valeur contenant des caractères HTML ne puisse pas
// s'injecter dans la page d'un autre appareil.
const _escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => _escMap[c]);
}
function searchNorm(v) {
  return String(v == null ? '' : v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ── STOCKAGE LOCAL (IndexedDB) ──
let _saveTimer = null;
function _saveLocalNow() {
  _saveTimer = null;
  // persistance durable en arrière-plan ; toute erreur est rendue VISIBLE
  DB.putAllPoints(state.points)
    .then(() => { if (_storageWarn) setStorageWarn(false); })
    .catch((e) => { console.error('Stockage:', e); setStorageWarn(true); showToast('⚠ Échec stockage local — vérifiez l\'espace', 'error'); });
  migrateLegacyLocalStorage();
}
function saveLocal() {
  // Débounce 400 ms : regroupe les écritures rapprochées (édition en masse, lasso…)
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_saveLocalNow, 400);
}
// Filet : si l'app passe en arrière-plan, on écrit immédiatement ce qui est en attente
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && _saveTimer) _saveLocalNow(); });
window.addEventListener('pagehide', () => { if (_saveTimer) _saveLocalNow(); });
async function loadLocal() {
  try {
    const pts = await DB.all('points');
    if (pts && pts.length) { state.points = pts; return; }
    // migration unique depuis l'ancien localStorage si présent
    const d = localStorage.getItem('audit_ep_points');
    if (d) { state.points = JSON.parse(d); await DB.putAllPoints(state.points); }
  } catch (e) { console.error('loadLocal', e); setStorageWarn(true); }
}
function migrateLegacyLocalStorage() {
  try { if (localStorage.getItem('audit_ep_points')) localStorage.removeItem('audit_ep_points'); } catch (e) {}
}

// ── STOCKAGE LOCAL ARMOIRES ──
function saveLocalArmoires() {
  const db_save = async () => {
    const db = await DB.open();
    return new Promise((res, rej) => {
      const t = db.transaction('armoires', 'readwrite');
      const s = t.objectStore('armoires');
      s.clear();
      state.armoires.forEach(a => s.put(a));
      t.oncomplete = () => res(true);
      t.onerror = () => rej(t.error);
    });
  };
  db_save().catch(e => { console.error('saveArmoires:', e); showToast('⚠ Échec stockage armoires', 'error'); });
}
async function loadLocalArmoires() {
  try {
    const arms = await DB.all('armoires');
    if (arms && arms.length) state.armoires = arms;
  } catch (e) { console.error('loadArmoires', e); }
}

// ── LOGIN ──
// ── Chantiers dynamiques (liste partagée entre appareils via la Config) ──
function backToLogin() {
  if (!confirm('Revenir à la page de connexion ?\n(Vos données restent enregistrées et synchronisées.)')) return;
  document.querySelectorAll('.screen').forEach(sc => sc.classList.remove('active'));
  const lg = document.getElementById('screen-login');
  lg.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(nv => nv.classList.remove('active'));
  const bn = document.getElementById('bottom-nav'); if (bn) bn.style.display = 'none';
  populateChantierSelect('');
}
function populateChantierSelect(selected) {
  const sel = document.getElementById('login-chantier');
  if (!sel) return;
  const list = (CONFIG && Array.isArray(CONFIG.chantiers) && CONFIG.chantiers.length)
    ? CONFIG.chantiers : CONFIG_DEFAULT.chantiers;
  sel.innerHTML = '<option value="">-- Sélectionner --</option>' +
    list.map(c => `<option${c === selected ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('') +
    '<option value="__new">＋ Nouveau PEEEPS…</option>';
  if (selected) sel.value = selected;
}
async function deleteChantierFromLogin() {
  const sel = document.getElementById('login-chantier');
  const name = sel.value;
  if (!name || name === '__new') { showToast('Sélectionnez d\u2019abord un PEEEPS', 'error'); return; }
  if (!confirm('Retirer le PEEEPS « ' + name + ' » de la liste ?\n\nLes points et photos déjà dans le Sheet ne sont PAS supprimés — seul le PEEEPS disparaît de la liste de connexion.')) return;
  CONFIG.chantiers = (CONFIG.chantiers || CONFIG_DEFAULT.chantiers).filter(c => c !== name);
  await saveConfig();
  populateChantierSelect('');
  showToast('PEEEPS « ' + name + ' » retiré de la liste', 'success');
}
async function addChantierFromLogin(sel) {
  const name = (prompt('Nom du nouveau PEEEPS :') || '').trim();
  if (!name) { sel.value = ''; return; }
  if (!Array.isArray(CONFIG.chantiers)) CONFIG.chantiers = CONFIG_DEFAULT.chantiers.slice();
  if (!CONFIG.chantiers.includes(name)) {
    CONFIG.chantiers.push(name);
    CONFIG.chantiers.sort((a, b) => a.localeCompare(b, 'fr'));
    await saveConfig();          // partagé avec les autres appareils via l'onglet Config
  }
  populateChantierSelect(name);
  showToast('PEEEPS « ' + name + ' » créé — vous pouvez vous connecter', 'success');
}
// Au démarrage : charge la config locale pour remplir la liste avant la connexion
(async function preloadChantiers() {
  try {
    const rec = await DB.get('meta', 'config');
    if (rec && rec.v && Array.isArray(rec.v.chantiers) && rec.v.chantiers.length) {
      CONFIG.chantiers = rec.v.chantiers;
    }
  } catch (e) {}
  populateChantierSelect('');
})();

async function doLogin() {
  const prenom = document.getElementById('login-prenom').value.trim();
  const nom = document.getElementById('login-nom').value.trim();
  const chantier = document.getElementById('login-chantier').value;
  if (!prenom || !nom || !chantier) { showToast('Remplissez tous les champs', 'error'); return; }
  const _prevCh = state.chantier;
  state.technicien = prenom + ' ' + nom;
  state.chantier = chantier;
  if (_prevCh !== chantier) clearHistory();   // l'historique annuler/rétablir ne traverse pas les PEEEPS
  await loadLocal();
  await loadLocalArmoires();
  await loadConfig();
  await restoreTemplatesLocal();     // trames dispo hors-ligne dès l'ouverture
  document.getElementById('map-chantier-label').textContent = chantier;
  document.getElementById('map-technicien-label').textContent = state.technicien;
  document.getElementById('bottom-nav').style.display = 'flex';
  const _mapExisted = !!map;          // reconnexion (carte déjà créée) : il faut réappliquer le contexte du PEEEPS
  showScreen('map');
  initMap();
  if (_mapExisted) refreshPeeepsContext(); else populateMapPeeepsSwitch();
  updateStatus();
}

// Liste déroulante de la barre de la carte : changer de PEEEPS sans repasser par la connexion
function populateMapPeeepsSwitch() {
  const sel = document.getElementById('map-peeeps-switch');
  if (!sel) return;
  const list = ((CONFIG && Array.isArray(CONFIG.chantiers) && CONFIG.chantiers.length) ? CONFIG.chantiers : CONFIG_DEFAULT.chantiers).slice();
  if (state.chantier && !list.includes(state.chantier)) list.push(state.chantier);
  sel.innerHTML = list.map(c => `<option${c === state.chantier ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');
  if (state.chantier) sel.value = state.chantier;
}
// Tout ce qui est propre à un PEEEPS (filtres, plan client, modes de saisie, vue) est remis à neuf
function refreshPeeepsContext() {
  document.getElementById('map-chantier-label').textContent = state.chantier;
  populateMapPeeepsSwitch();
  if (poseMode) togglePose();
  if (armoirePoseMode) toggleArmoirePose();
  if (lassoMode) toggleLasso();
  if (moveGroupMode) cancelMoveGroup();
  state.filterArmoire = []; state.filterChamp = null; _champSel = new Set(); _filterSig = '';
  const cb = document.getElementById('map-champ-btn'); if (cb) cb.textContent = 'Filtre caractéristique';
  updateFilterBtn();
  window._listLimit = 0;
  if (map) {
    map.closePopup();
    removeOverlay(false);
    restoreOverlay();
    refreshMapMarkers();
    const pts = peeepsPoints().filter(p => p.lat && p.lng).map(p => [p.lat, p.lng]);
    peeepsArmoires().forEach(a => { if (a.lat && a.lng) pts.push([a.lat, a.lng]); });
    if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 19 });
  }
  renderList(); renderPanier(); renderArmoires();
  // nouveau chargement serveur pour ce PEEEPS (attend la fin d'un éventuel chargement en cours)
  (function go(n) { if (isLoading && n < 20) { setTimeout(() => go(n + 1), 500); return; } loadFromSheets(); })(0);
}
async function switchPeeeps(name) {
  const sel = document.getElementById('map-peeeps-switch');
  if (!name || name === state.chantier) return;
  const calib = document.getElementById('calib-screen');
  if (calibWaitMap || (calib && calib.classList.contains('show'))) {
    showToast('Terminez ou annulez le calage du plan avant de changer de PEEEPS', 'error');
    if (sel) sel.value = state.chantier;
    return;
  }
  if (_saveTimer) { clearTimeout(_saveTimer); _saveLocalNow(); }   // rien n'est perdu au changement
  state.chantier = name;
  clearHistory();
  refreshPeeepsContext();
  showToast('PEEEPS « ' + name + ' »', 'success');
}

// ── SCREENS ──
let currentScreen = 'login';
function showScreen(name) {
  if (name !== 'form' && name !== 'armoire-form') state.previousScreen = currentScreen;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navEl = document.getElementById('nav-' + name);
  if (navEl) navEl.classList.add('active');
  currentScreen = name;
  if (name === 'list') renderList();
  if (name === 'panier') renderPanier();
  if (name === 'map') refreshMapMarkers();   // couvre aussi le rendu différé (mapDirty)
  if (name === 'armoires') renderArmoires();
  if (name === 'settings') renderSettings();
}
function goBack() {
  if (currentScreen === 'form') { showScreen('map'); return; }
  if (currentScreen === 'armoire-form') { showScreen('armoires'); return; }
  showScreen(state.previousScreen);
}

// ── MAP ──
let map, markersLayer, pointsCluster, _canvasRenderer, osmLayer, satLayer, ignLayer, baseMode = 0; // 0=Plan, 1=Satellite IGN, 2=Satellite Esri
const markersById = new Map(); // id point → marqueur Leaflet (pour le déplacement au doigt)
const armoireMarkersById = new Map(); // id armoire → marqueur Leaflet
function initMap() {
  if (map) return; // évite une double init
  map = L.map('map', {
    zoomAnimation: false, markerZoomAnimation: false, fadeAnimation: false, preferCanvas: true, zoomControl: false, attributionControl: false, maxZoom: 21 }).setView([16.25, -61.55], 11);
  _canvasRenderer = L.canvas({ padding: 0.5 });
  const _tileOpts = {
    updateWhenIdle: true,        // ne charge les tuiles qu'une fois le doigt relâché → bien plus fluide
    updateWhenZooming: false,    // pas de rechargement pendant l'animation de zoom
    keepBuffer: 4,               // garde une marge de tuiles autour → moins de trous au pan
    detectRetina: false          // évite de charger 4× plus de tuiles sur écrans haute densité
  };
  osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', Object.assign({
    maxZoom: 21, maxNativeZoom: 19, crossOrigin: true, attribution: '© OpenStreetMap'
  }, _tileOpts)).addTo(map);
  // Imagerie satellite Esri World Imagery (gratuite, sans clé) — l'autre fond de carte alterné au bouton.
  satLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', Object.assign({
    maxZoom: 21, maxNativeZoom: 18, crossOrigin: true, attribution: 'Tiles © Esri'
  }, _tileOpts));
  // Orthophotos IGN (Géoplateforme, gratuit sans clé) — imagerie française haute résolution, couvre la Guadeloupe.
  ignLayer = L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}', Object.assign({
    maxZoom: 21, maxNativeZoom: 19, crossOrigin: true, attribution: 'Orthophotos © IGN'
  }, _tileOpts));
  markersLayer = L.layerGroup().addTo(map);   // armoires : toujours visibles, non regroupées
  _canvasRenderer.addTo(map);
  // Points : regroupés en clusters pour rester fluide même avec des milliers de points.
  // Repli automatique sur un simple calque si le plugin n'est pas chargé (1er lancement hors-ligne).
  pointsCluster = (typeof L.markerClusterGroup === 'function')
    ? L.markerClusterGroup({
        chunkedLoading: true,          // ajoute les marqueurs par lots → pas de gel de l'UI
        chunkInterval: 100, chunkDelay: 20,
        maxClusterRadius: 70,          // regroupe un peu plus → moins d'objets à dessiner
        disableClusteringAtZoom: 19,   // on ne "dé-cluster" qu'au zoom terrain
        spiderfyOnMaxZoom: false,
        removeOutsideVisibleBounds: true,
        animate: false,                // pas d'animation de cluster = beaucoup plus fluide
        animateAddingMarkers: false
      })
    : L.layerGroup();
  pointsCluster.addTo(map);
  map.on('click', (e) => {
    if (calibWaitMap) { calibMapTapped(e.latlng); return; }   // calage de plan prioritaire
    if (armoirePoseMode) { placeArmoireOnMap(e.latlng); return; }
    if (poseMode && !lassoMode) addPointOnMap(e.latlng);
  });
  const cont = map.getContainer();
  cont.addEventListener('pointerdown', lassoDown);
  cont.addEventListener('pointermove', lassoMoveHandler, { passive: false });
  cont.addEventListener('pointerup', lassoUp);
  cont.addEventListener('pointercancel', lassoUp);
  cont.addEventListener('pointerdown', moveGroupDown);
  cont.addEventListener('pointermove', moveGroupMoveHandler, { passive: false });
  cont.addEventListener('pointerup', moveGroupUp);
  cont.addEventListener('pointercancel', moveGroupCancelDrag);
  loadFromSheets();
  restoreOverlay();
  centerOnMe();
  startPolling();   // rafraîchit depuis le Sheet toutes les 30 s (si en ligne + app au premier plan)
}

// Bascule entre le fond de carte OpenStreetMap (plan) et l'imagerie satellite Esri.
// Fait défiler les fonds de carte à chaque appui : Plan → Satellite IGN → Satellite Esri → Plan.
const BASEMODES = [
  { name: 'Plan', get: () => osmLayer },
  { name: 'Satellite IGN', get: () => ignLayer },
  { name: 'Satellite Esri', get: () => satLayer }
];
function toggleSatellite() {
  if (!map) return;
  const prev = BASEMODES[baseMode].get();
  baseMode = (baseMode + 1) % BASEMODES.length;
  const next = BASEMODES[baseMode];
  if (prev) map.removeLayer(prev);
  next.get().addTo(map);
  const btn = document.getElementById('sat-btn');
  if (btn) btn.classList.toggle('active', baseMode !== 0);
  showToast(next.name, '');
}

/* ════════ Mode Pose (poser un point en touchant la carte) ════════ */
let poseMode = false;
function togglePose() {
  poseMode = !poseMode;
  if (poseMode) { if (lassoMode) toggleLasso(); if (armoirePoseMode) toggleArmoirePose(); }  // modes exclusifs
  document.getElementById('pose-btn').classList.toggle('active', poseMode);
  showToast(poseMode ? 'Mode pose : tapez la carte pour poser un point' : 'Mode pose désactivé', '');
}
function addPointOnMap(latlng) {
  const pt = {
    id: generateId(),
    chantier: state.chantier,
    technicien: state.technicien,
    date: new Date().toISOString().split('T')[0],
    lat: latlng.lat, lng: latlng.lng,
    gpsAccuracy: null,
    sourcePosition: 'Carte (manuel)',
    classePrecision: 'C',
    idArmoire: '',
    nbrSupports: '', typeSupport: '', etatSupport: '', hauteur: '',
    typeAttache: '', nbrLuminaires: '', typeLuminaire: '', etatLuminaire: '',
    technologie: '', puissance: '', observations: '',
    dansPanier: false,
    photos: { luminaire: false, mat: false, classe2: false }
  };
  state.points.push(pt);
  saveLocal();
  refreshMapMarkers();
  syncPointToSheets(pt);
  updateStatus();
  showToast('Point posé — caractérisez-le ensuite', 'success');
}

/* ════════ Mode Pose Armoire (poser une armoire en touchant la carte) ════════ */
let armoirePoseMode = false;
function toggleArmoirePose() {
  armoirePoseMode = !armoirePoseMode;
  if (armoirePoseMode) { if (poseMode) togglePose(); if (lassoMode) toggleLasso(); }  // modes exclusifs
  const btn = document.getElementById('pose-armoire-btn');
  if (btn) btn.classList.toggle('active', armoirePoseMode);
  showToast(armoirePoseMode ? 'Tapez la carte pour poser une armoire' : 'Mode armoire désactivé', '');
}
function placeArmoireOnMap(latlng) {
  armoirePoseMode = false;
  const btn = document.getElementById('pose-armoire-btn');
  if (btn) btn.classList.remove('active');
  showArmoireForm(null);                              // ouvre une fiche armoire vierge
  armGPSLat = latlng.lat; armGPSLng = latlng.lng;     // coordonnées du point tapé sur la carte
  const el = document.getElementById('arm-gps-display');
  if (el) { el.textContent = armGPSLat.toFixed(6) + ', ' + armGPSLng.toFixed(6); el.classList.remove('empty'); }
  showToast('Armoire placée — complétez la fiche', 'success');
}

/* ════════ Lasso (sélection libre au doigt) ════════ */
let lassoMode = false, lassoActive = false, lassoPts = [], lassoLine = null;
function toggleLasso() {
  lassoMode = !lassoMode;
  if (lassoMode) { if (poseMode) togglePose(); if (armoirePoseMode) toggleArmoirePose(); }  // modes exclusifs
  document.getElementById('lasso-btn').classList.toggle('active', lassoMode);
  document.getElementById('lasso-hint').classList.toggle('show', lassoMode);
  if (map) map.getContainer().classList.toggle('lasso-on', lassoMode);
  if (lassoMode) { map.dragging.disable(); map.doubleClickZoom.disable(); if (map.touchZoom) map.touchZoom.disable(); }
  else { map.dragging.enable(); map.doubleClickZoom.enable(); if (map.touchZoom) map.touchZoom.enable(); clearLasso(); }
}
function clearLasso() { lassoActive = false; lassoPts = []; if (lassoLine) { map.removeLayer(lassoLine); lassoLine = null; } }
function _evLatLng(ev) {
  const rect = map.getContainer().getBoundingClientRect();
  return map.containerPointToLatLng([ev.clientX - rect.left, ev.clientY - rect.top]);
}
function lassoDown(ev) {
  if (!lassoMode) return;
  ev.preventDefault();
  lassoActive = true;
  lassoPts = [_evLatLng(ev)];
  if (lassoLine) map.removeLayer(lassoLine);
  lassoLine = L.polyline(lassoPts, { color: '#e2e8f0', weight: 3, dashArray: '6 5' }).addTo(map);
}
function lassoMoveHandler(ev) {
  if (!lassoMode || !lassoActive) return;
  ev.preventDefault();
  lassoPts.push(_evLatLng(ev));
  lassoLine.setLatLngs(lassoPts);
}
function lassoUp() {
  if (!lassoMode || !lassoActive) return;
  lassoActive = false;
  finishLasso();
}
function pointInPoly(lat, lng, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lng, yi = poly[i].lat, xj = poly[j].lng, yj = poly[j].lat;
    const hit = ((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}
function finishLasso() {
  const poly = lassoPts.slice();
  clearLasso();
  // sortie du mode lasso
  lassoMode = false;
  document.getElementById('lasso-btn').classList.remove('active');
  document.getElementById('lasso-hint').classList.remove('show');
  map.getContainer().classList.remove('lasso-on');
  map.dragging.enable(); map.doubleClickZoom.enable(); if (map.touchZoom) map.touchZoom.enable();
  if (poly.length < 3) { showToast('Tracé trop court', 'error'); return; }
  const inside = state.points.filter(p => p.lat != null && p.lng != null
    && (!state.chantier || String(p.chantier || '') === String(state.chantier))
    // ne prendre que les points RÉELLEMENT AFFICHÉS (mêmes filtres que la carte)
    && (!state.filterArmoire.length || state.filterArmoire.includes(String(p.idArmoire)))
    && champFilterOK(p)
    && pointInPoly(p.lat, p.lng, poly));
  if (!inside.length) { showToast('Aucun point dans la zone', ''); return; }
  // Bascule point par point : ceux hors panier entrent, ceux déjà dedans sortent.
  let ajoutes = 0, retires = 0;
  inside.forEach(p => {
    if (p.dansPanier) { p.dansPanier = false; retires++; }
    else { p.dansPanier = true; ajoutes++; }
  });
  saveLocal();
  refreshMapMarkers();
  const nSel = panierPoints().length;
  let msg = [];
  if (ajoutes) msg.push(ajoutes + ' ajouté(s)');
  if (retires) msg.push(retires + ' retiré(s)');
  showToast((msg.join(' · ') || 'Aucun changement') + ' — ' + nSel + ' au total', ajoutes ? 'success' : '');
  // ouvre le menu d'action seulement si on a ajouté ET qu'il reste une sélection
  if (ajoutes && nSel) openModalMasseChoice();
}

/* ════════ Déplacement groupé (glisser tous les points du panier d'un même vecteur) ════════
   Principe : on ne bouge pas les vrais marqueurs pendant le glisser (ils sont dans un
   cluster, les redessiner en continu serait coûteux et saccadé). On affiche à la place
   des « fantômes » violets qui suivent le doigt, et on n'applique le déplacement réel
   aux points qu'au relâchement — avec undo, comme pour un déplacement individuel. */
let moveGroupMode = false, moveGroupActive = false, moveGroupStart = null;
let moveGroupOriginal = [];     // [{ id, lat, lng }] snapshot des points sélectionnés au départ du geste
let moveGroupGhostLayer = null; // calque des marqueurs fantômes affichés pendant le glisser

function startMoveGroup() {
  const pts = panierPoints().filter(p => p.lat != null && p.lng != null);
  if (!pts.length) { showToast('Aucun point sélectionné', 'error'); return; }
  if (poseMode) togglePose();
  if (lassoMode) toggleLasso();
  if (armoirePoseMode) toggleArmoirePose();
  moveGroupMode = true;
  moveGroupOriginal = pts.map(p => ({ id: p.id, lat: p.lat, lng: p.lng }));
  document.getElementById('movegroup-hint-count').textContent = pts.length;
  document.getElementById('movegroup-hint').classList.add('show');
  map.getContainer().classList.add('movegroup-on');
  map.dragging.disable(); map.doubleClickZoom.disable(); if (map.touchZoom) map.touchZoom.disable();
  showToast('Glissez sur la carte pour déplacer les ' + pts.length + ' points sélectionnés', '');
}

function endMoveGroupMode() {
  moveGroupMode = false;
  moveGroupActive = false;
  moveGroupStart = null;
  moveGroupOriginal = [];
  if (moveGroupGhostLayer) { map.removeLayer(moveGroupGhostLayer); moveGroupGhostLayer = null; }
  document.getElementById('movegroup-hint').classList.remove('show');
  map.getContainer().classList.remove('movegroup-on');
  map.dragging.enable(); map.doubleClickZoom.enable(); if (map.touchZoom) map.touchZoom.enable();
}

function cancelMoveGroup() {
  if (!moveGroupMode) return;
  endMoveGroupMode();
  showToast('Déplacement groupé annulé', '');
}

function buildMoveGroupGhosts() {
  moveGroupGhostLayer = L.layerGroup().addTo(map);
  moveGroupOriginal.forEach(o => {
    const m = L.circleMarker([o.lat, o.lng], {
      radius: 8, color: '#a78bfa', weight: 2, fillColor: '#a78bfa', fillOpacity: 0.55
    });
    m._origLat = o.lat; m._origLng = o.lng; m._ptId = o.id;
    m.addTo(moveGroupGhostLayer);
  });
}

function moveGroupDown(ev) {
  if (!moveGroupMode) return;
  ev.preventDefault();
  moveGroupActive = true;
  moveGroupStart = _evLatLng(ev);
  buildMoveGroupGhosts();
}

function moveGroupMoveHandler(ev) {
  if (!moveGroupMode || !moveGroupActive) return;
  ev.preventDefault();
  const cur = _evLatLng(ev);
  const dLat = cur.lat - moveGroupStart.lat, dLng = cur.lng - moveGroupStart.lng;
  if (moveGroupGhostLayer) {
    moveGroupGhostLayer.eachLayer(m => m.setLatLng([m._origLat + dLat, m._origLng + dLng]));
  }
}

function moveGroupCancelDrag() {
  if (!moveGroupMode || !moveGroupActive) return;
  moveGroupActive = false;
  if (moveGroupGhostLayer) { map.removeLayer(moveGroupGhostLayer); moveGroupGhostLayer = null; }
}

async function moveGroupUp(ev) {
  if (!moveGroupMode || !moveGroupActive) return;
  moveGroupActive = false;
  const cur = _evLatLng(ev);
  const dLat = cur.lat - moveGroupStart.lat, dLng = cur.lng - moveGroupStart.lng;
  const snapshot = moveGroupOriginal.slice();
  endMoveGroupMode();
  if (Math.abs(dLat) < 1e-7 && Math.abs(dLng) < 1e-7) { showToast('Aucun déplacement — geste trop court', ''); return; }
  const entries = [];
  const moved = [];
  snapshot.forEach(o => {
    const pt = state.points.find(p => p.id === o.id);
    if (!pt) return;
    entries.push({ id: pt.id, before: cloneEntry(pt) });
    pt.lat = o.lat + dLat;
    pt.lng = o.lng + dLng;
    pt.sourcePosition = 'Déplacement groupé (carte)';
    moved.push(pt);
  });
  if (!moved.length) return;
  pushUndo('Déplacement groupé de ' + moved.length + ' point' + (moved.length > 1 ? 's' : ''), entries);
  saveLocal();
  refreshMapMarkers();
  updateStatus();
  showToast(moved.length + ' point' + (moved.length > 1 ? 's' : '') + ' déplacé' + (moved.length > 1 ? 's' : '') + ' — sync…', 'success');
  for (const p of moved) { await syncPointToSheets(p); }
  updateStatus();
}

/* ═══════ TÉLÉCHARGEMENT HORS-LIGNE DE LA ZONE VISIBLE ═══════ */
const TILE_CACHE_NAME = 'audit-ep-tiles-v1';   // doit rester identique à sw.js
let _dlCancel = false, _dlRunning = false;
function _lon2x(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function _lat2y(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
}
function _activeBaseLayer() {
  return baseMode === 1 ? ignLayer : (baseMode === 2 ? satLayer : osmLayer);
}
function _tileUrl(layer, x, y, z) {
  let u = layer._url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  if (u.indexOf('{s}') >= 0) {
    const subs = layer.options.subdomains || 'abc';
    u = u.replace('{s}', subs[Math.abs(x + y) % subs.length]);
  }
  return u.replace('{r}', '');
}
async function startTileDownload() {
  if (_dlRunning) { showToast('Téléchargement déjà en cours', ''); return; }
  const layer = _activeBaseLayer();
  const names = ['Plan OSM', 'Satellite IGN', 'Satellite Esri'];
  const zMax = Math.min(layer.options.maxNativeZoom || 19, 19);
  const zMin = Math.min(Math.max(Math.floor(map.getZoom()), 12), zMax);
  const b = map.getBounds();
  const jobs = [];
  for (let z = zMin; z <= zMax; z++) {
    const x1 = _lon2x(b.getWest(), z), x2 = _lon2x(b.getEast(), z);
    const y1 = _lat2y(b.getNorth(), z), y2 = _lat2y(b.getSouth(), z);
    for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) jobs.push({ x, y, z });
  }
  if (jobs.length > 20000) {
    showToast('Zone trop grande (' + jobs.length + ' tuiles) — zoomez davantage avant de télécharger', 'error');
    return;
  }
  const mo = Math.round(jobs.length * 18 / 1024);
  if (!confirm('Télécharger la zone visible pour le hors-ligne ?\n\nFond : ' + names[baseMode] +
      '\nZooms ' + zMin + ' → ' + zMax + '\n≈ ' + jobs.length + ' tuiles (~' + mo + ' Mo)' +
      (jobs.length > 6000 ? '\n\n⚠ Volume important : restez en wifi.' : ''))) return;
  _dlCancel = false; _dlRunning = true;
  const banner = document.getElementById('dl-banner');
  const txt = document.getElementById('dl-txt');
  banner.classList.add('show');
  const cache = await caches.open(TILE_CACHE_NAME);
  let done = 0, fail = 0;
  const CONC = 8;
  for (let i = 0; i < jobs.length && !_dlCancel; i += CONC) {
    const batch = jobs.slice(i, i + CONC).map(async (t) => {
      const url = _tileUrl(layer, t.x, t.y, t.z);
      try {
        if (await cache.match(url)) { done++; return; }
        let resp;
        try { resp = await fetch(url); }
        catch (e1) { resp = await fetch(url, { mode: 'no-cors' }); }
        if (resp && (resp.ok || resp.type === 'opaque')) { await cache.put(url, resp); done++; }
        else fail++;
      } catch (e) { fail++; }
    });
    await Promise.allSettled(batch);
    txt.innerHTML = 'Hors-ligne : <b>' + (done + fail) + '</b> / ' + jobs.length + ' tuiles';
  }
  _dlRunning = false;
  requestPersistence();
  banner.classList.remove('show');
  if (_dlCancel) showToast('Téléchargement interrompu — ' + done + ' tuiles conservées', '');
  else showToast('Zone téléchargée ✓ ' + done + ' tuiles' + (fail ? ' (' + fail + ' échecs)' : '') + ' — disponible hors-ligne', 'success');
}
function cancelTileDownload() { _dlCancel = true; }

/* ═══════ CALAGE DE PLAN CLIENT (géoréférencement par 2 repères) ═══════
   Principe : l'utilisateur tape 2 endroits reconnaissables sur l'image, puis les
   mêmes sur la vraie carte. Pour une capture orientée nord (cas des SIG), on en
   déduit l'échelle X/Y et la position → l'image s'affiche calée en transparence.
   L'overlay est mémorisé PAR CHANTIER et restauré au démarrage. */
let calibImg = null;          // { dataURL, w, h }
let calibPts = [];            // [{px,py}] repères image
let calibLL = [];             // [latlng] repères carte
let calibWaitMap = false;
let overlayLayer = null;
let overlayVisible = true;
let overlayOpacity = 0.55;

function startCalibration() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.style.display = 'none';
  document.body.appendChild(input);                 // indispensable en PWA iOS
  const cleanup = () => { try { document.body.removeChild(input); } catch (e) {} };
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) { cleanup(); return; }
    const img = new Image();
    img.onload = () => {
      // Réduction raisonnable (2048px max) pour le stockage local
      const scale = Math.min(1, 2048 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      calibImg = { dataURL: c.toDataURL('image/jpeg', 0.85), w: c.width, h: c.height };
      URL.revokeObjectURL(img.src);
      calibPts = []; calibLL = [];
      openCalibScreen();
    };
    img.onerror = () => { showToast('Image illisible', 'error'); cleanup(); };
    img.src = URL.createObjectURL(file);
    cleanup();
  };
  input.click();
}
function openCalibScreen() {
  const scr = document.getElementById('calib-screen');
  const img = document.getElementById('calib-img');
  document.getElementById('calib-imgnum').textContent = String(calibPts.length + 1);
  img.src = calibImg.dataURL;
  // affichage à ~1.2x la largeur écran pour pouvoir zoomer/pan au doigt
  img.style.width = Math.max(window.innerWidth * 1.2, calibImg.w * 0.4) + 'px';
  document.querySelectorAll('.calib-pin').forEach(el => el.remove());
  calibPts.forEach((p, i) => placeCalibPin(p, i));
  img.onclick = (ev) => {
    const r = img.getBoundingClientRect();
    const px = (ev.clientX - r.left) / r.width * calibImg.w;
    const py = (ev.clientY - r.top) / r.height * calibImg.h;
    calibPts.push({ px, py });
    placeCalibPin({ px, py }, calibPts.length - 1);
    scr.classList.remove('show');
    calibWaitMap = true;
    showScreen('map');
    document.getElementById('calib-mapnum').textContent = String(calibPts.length);
    document.getElementById('calib-mapbanner').classList.add('show');
    showToast('Repère image ' + calibPts.length + ' posé — tapez le même endroit sur la carte', '');
  };
  scr.classList.add('show');
}
function placeCalibPin(p, i) {
  const img = document.getElementById('calib-img');
  const wrap = document.getElementById('calib-imgwrap');
  const pin = document.createElement('div');
  pin.className = 'calib-pin ' + (i === 0 ? 'p1' : 'p2');
  const place = () => {
    const iw = img.clientWidth, ih = img.clientHeight;
    pin.style.left = (img.offsetLeft + p.px / calibImg.w * iw) + 'px';
    pin.style.top = (img.offsetTop + p.py / calibImg.h * ih) + 'px';
  };
  place();
  wrap.appendChild(pin);
}
function calibMapTapped(latlng) {
  calibWaitMap = false;
  document.getElementById('calib-mapbanner').classList.remove('show');
  calibLL.push(latlng);
  if (calibPts.length < 2) {
    openCalibScreen();                              // au tour du repère 2 sur l'image
    return;
  }
  finishCalibration();
}
function finishCalibration() {
  const [a, b] = calibPts;
  const [A, B] = calibLL;
  const dpx = b.px - a.px, dpy = b.py - a.py;
  const dlng = B.lng - A.lng, dlat = B.lat - A.lat;
  if (Math.abs(dpx) < 12 || Math.abs(dpy) < 12) {
    showToast('Repères trop proches ou alignés — choisissez 2 points bien écartés en diagonale', 'error');
    calibPts = []; calibLL = [];
    openCalibScreen();
    return;
  }
  const lngPerPx = dlng / dpx;
  const latPerPx = dlat / dpy;
  const west = A.lng - a.px * lngPerPx;
  const north = A.lat - a.py * latPerPx;
  const east = west + calibImg.w * lngPerPx;
  const south = north + calibImg.h * latPerPx;
  const bounds = [[Math.min(north, south), Math.min(west, east)], [Math.max(north, south), Math.max(west, east)]];
  applyOverlay(calibImg.dataURL, bounds);
  // mémorisé par chantier
  DB.put('meta', { k: 'overlay_' + state.chantier, v: { dataURL: calibImg.dataURL, bounds } }).catch(() => {});
  map.fitBounds(bounds, { padding: [30, 30] });
  showToast('Plan calé ✓ — réglez la transparence en bas à gauche', 'success');
}
function applyOverlay(dataURL, bounds) {
  removeOverlay(false);
  overlayLayer = L.imageOverlay(dataURL, bounds, { opacity: overlayOpacity, interactive: false }).addTo(map);
  overlayVisible = true;
  document.getElementById('ob-eye').textContent = '👁';
  document.getElementById('overlay-bar').classList.add('show');
}
async function restoreOverlay() {
  try {
    const rec = await DB.get('meta', 'overlay_' + state.chantier);
    if (rec && rec.v && rec.v.dataURL && rec.v.bounds) applyOverlay(rec.v.dataURL, rec.v.bounds);
  } catch (e) {}
}
function setOverlayOpacity(v) {
  overlayOpacity = Number(v) / 100;
  if (overlayLayer && overlayVisible) overlayLayer.setOpacity(overlayOpacity);
}
function toggleOverlayVisible() {
  if (!overlayLayer) return;
  overlayVisible = !overlayVisible;
  overlayLayer.setOpacity(overlayVisible ? overlayOpacity : 0);
  document.getElementById('ob-eye').textContent = overlayVisible ? '👁' : '🚫';
}
function removeOverlay(forget) {
  if (overlayLayer) { map.removeLayer(overlayLayer); overlayLayer = null; }
  document.getElementById('overlay-bar').classList.remove('show');
  if (forget) {
    DB.del('meta', 'overlay_' + state.chantier).catch(() => {});
    showToast('Plan retiré', '');
  }
}
function cancelCalibration() {
  document.getElementById('calib-screen').classList.remove('show');
  document.getElementById('calib-mapbanner').classList.remove('show');
  calibWaitMap = false; calibPts = []; calibLL = []; calibImg = null;
}

// Un point est "solaire" si son champ perso Solaire est renseigné (hors 'infaisable'),
// ou si sa technologie/type de luminaire mentionne le solaire.
// Étoile UNIQUEMENT si le champ « Solaire » vaut explicitement oui.
// « non », vide, ou toute autre valeur → point rond normal.
function isSolarPoint(pt){
  const sol = String((pt.custom && (pt.custom['Solaire'] || pt.custom['solaire'])) || '').trim();
  if (!sol) return false;
  const v = _normVal(sol);
  return v === 'oui' || v === 'yes' || v === 'true' || v === 'o' || v === 'x';
}
// Rond par défaut ; étoile pour les points solaires.
function markerShapeHTML(pt, color){
  // Point vérifié → halo/contour VERT bien visible
  const vert = pt && pt.verifie;
  if (isSolarPoint(pt)) {
    const bord = vert ? '#22c55e' : color.border;
    const bw = vert ? 2.4 : 1.4;
    return '<svg width="18" height="18" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))' + (vert ? ' drop-shadow(0 0 3px #22c55e)' : '') + '">' +
      '<path d="M12 2l2.9 6.3 6.9.7-5.1 4.7 1.4 6.8L12 17.8 5.9 20.5l1.4-6.8L2.2 9l6.9-.7z" ' +
      'fill="' + color.fill + '" stroke="' + bord + '" stroke-width="' + bw + '" stroke-linejoin="round"/></svg>';
  }
  const bord = vert ? '#22c55e' : color.border;
  const bw = vert ? 3 : 2;
  const glow = vert ? ',0 0 0 2px rgba(34,197,94,.4)' : '';
  return '<div style="width:14px;height:14px;border-radius:50%;background:' + color.fill + ';border:' + bw + 'px solid ' + bord + ';box-shadow:0 2px 6px rgba(0,0,0,0.4)' + glow + '"></div>';
}
function getMarkerColor(pt) {
  const colors = (CONFIG && CONFIG.colors) || {};
  const dfl = colors._default || { fill: '#e2e8f0', border: '#ffffff' };
  if (pt.dansPanier) return { fill: '#fb923c', border: '#ffffff' };
  const field = (CONFIG && CONFIG.colorField) || 'etatSupport';
  let val;
  if (field.indexOf('custom:') === 0) { const col = field.slice(7); val = (pt.custom && pt.custom[col]) || ''; }
  else { val = pt[field] || ''; }
  if (val && colors[val]) return colors[val];
  return dfl;
}

// \u2500\u2500 Filtre de la carte par armoire \u2500\u2500
let _filterSig = '';
let _armIdsSorted = [];
function _filterSet() { return new Set((state.filterArmoire || []).map(String)); }
function populateArmoireFilter() {
  const ids = new Set();
  const okC = x => !state.chantier || String((x && x.chantier) || '') === String(state.chantier);
  state.armoires.forEach(a => { if (a.id && okC(a)) ids.add(String(a.id)); });
  state.points.forEach(p => { if (p.idArmoire && okC(p)) ids.add(String(p.idArmoire)); });
  const sorted = [...ids].sort();
  const sig = sorted.join('|') + '§' + (state.filterArmoire || []).slice().sort().join(',');
  if (sig === _filterSig) return;
  _filterSig = sig;
  _armIdsSorted = sorted;
  state.filterArmoire = (state.filterArmoire || []).filter(id => ids.has(String(id)));
  updateFilterBtn();
  renderFilterPanel();
}
function updateFilterBtn() {
  const btn = document.getElementById('map-filter-btn');
  if (!btn) return;
  const nsel = (state.filterArmoire || []).length;
  btn.textContent = nsel === 0 ? 'Toutes les armoires'
    : (nsel === 1 ? 'Armoire ' + state.filterArmoire[0] : nsel + ' armoires ✓');
  btn.classList.toggle('active', nsel > 0);
}
function renderFilterPanel() {
  const list = document.getElementById('mfp-list');
  if (!list) return;
  const sel = _filterSet();
  const allBtn = document.getElementById('mfp-all-btn');
  if (allBtn) allBtn.textContent = (_armIdsSorted.length && sel.size >= _armIdsSorted.length) ? 'Tout désélectionner' : 'Tout sélectionner';
  const q = (document.getElementById('mfp-search')?.value || '').toLowerCase().trim();
  const shown = q ? _armIdsSorted.filter(id => id.toLowerCase().includes(q)) : _armIdsSorted;
  list.innerHTML = shown.map(id => `
    <div class="mfp-item${sel.has(id) ? ' on' : ''}" onclick="toggleArmoireInFilter('${escapeHtml(id)}')">
      <span>${escapeHtml(id)}</span><span class="mfp-check">${sel.has(id) ? '✓' : ''}</span>
    </div>`).join('') || '<div class="set-empty" style="padding:8px">' + (q ? 'Aucune armoire « ' + escapeHtml(q) + ' »' : 'Aucune armoire') + '</div>';
}
/* ═══ FILTRE PAR CARACTÉRISTIQUE (champ + valeur) ═══ */
function champFilterOK(pt) {
  const f = state.filterChamp;
  if (!f || !f.field || !f.values || !f.values.length) return true;
  const def = masseFieldById(f.field);
  if (!def) return true;
  const v = String(def.custom ? ((pt.custom && pt.custom[def.custom]) || '') : (pt[def.key] || '')).trim();
  return f.values.some(x => x === '__vide' ? v === '' : _normVal(v) === _normVal(x));
}
let _champSel = new Set();      // valeurs cochées dans le panneau
let _champListe = [];           // valeurs proposées
function toggleChampPanel() {
  const p = document.getElementById('map-champ-panel');
  p.classList.toggle('show');
  if (p.classList.contains('show')) renderChampFields();
}
function renderChampFields() {
  const sel = document.getElementById('champ-field');
  if (!sel) return;
  const cur = state.filterChamp ? state.filterChamp.field : '';
  sel.innerHTML = masseFieldDefs()
    .map(d => `<option value="${escapeHtml(d.id)}"${d.id === cur ? ' selected' : ''}>${escapeHtml(d.label)}</option>`).join('');
  renderChampValues();
}
function renderChampValues(garderSelection) {
  const fSel = document.getElementById('champ-field');
  const box = document.getElementById('champ-values');
  if (!fSel || !box) return;
  const def = masseFieldById(fSel.value);
  const vues = new Set();
  state.points.forEach(p => {
    if (state.chantier && String(p.chantier || '') !== String(state.chantier)) return;
    const v = def && def.custom ? ((p.custom && p.custom[def.custom]) || '') : (def ? (p[def.key] || '') : '');
    if (String(v).trim() !== '') vues.add(String(v).trim());
  });
  (def && def.options ? def.options : []).forEach(o => { if (String(o).trim()) vues.add(String(o).trim()); });
  _champListe = [...vues].sort((a, b) => a.localeCompare(b, 'fr'));
  _champListe.push('__vide');
  if (!garderSelection) {
    // si le filtre actif porte sur ce champ, on recoche ses valeurs
    _champSel = new Set(
      (state.filterChamp && state.filterChamp.field === fSel.value) ? state.filterChamp.values : []);
  }
  box.innerHTML = _champListe.map(v => `
    <div class="mfp-item${_champSel.has(v) ? ' on' : ''}" onclick="toggleChampValue('${escapeHtml(v).replace(/'/g, "\\'")}')">
      <span>${v === '__vide' ? '— (non renseigné) —' : escapeHtml(v)}</span>
      <span class="mfp-check">${_champSel.has(v) ? '✓' : ''}</span>
    </div>`).join('') || '<div class="set-empty" style="padding:8px">Aucune valeur</div>';
  const cnt = document.getElementById('champ-count');
  if (cnt) cnt.textContent = _champSel.size ? '(' + _champSel.size + ' sélectionnée' + (_champSel.size > 1 ? 's' : '') + ')' : '';
  const btn = document.getElementById('champ-all-btn');
  if (btn) btn.textContent = (_champListe.length && _champSel.size >= _champListe.length) ? 'Tout désélectionner' : 'Tout sélectionner';
}
function toggleChampValue(v) {
  if (_champSel.has(v)) _champSel.delete(v); else _champSel.add(v);
  renderChampValues(true);
}
function toggleAllChampValues() {
  if (_champSel.size >= _champListe.length) _champSel = new Set();
  else _champSel = new Set(_champListe);
  renderChampValues(true);
}
function applyChampFilter() {
  const f = document.getElementById('champ-field').value;
  const vals = [..._champSel];
  if (!f || !vals.length) { showToast('Cochez au moins une valeur', 'error'); return; }
  state.filterChamp = { field: f, values: vals };
  const def = masseFieldById(f);
  const btn = document.getElementById('map-champ-btn');
  const libelle = vals.length === 1
    ? (vals[0] === '__vide' ? 'non renseigné' : vals[0])
    : vals.length + ' valeurs';
  if (btn) btn.textContent = (def ? def.label : '') + ' : ' + libelle;
  refreshMapMarkers();
  toggleChampPanel();
  const n = state.points.filter(p => p.lat && p.lng && champFilterOK(p)
    && (!state.chantier || String(p.chantier || '') === String(state.chantier))).length;
  showToast(n + ' point(s) correspondent', 'success');
}
function clearChampFilter() {
  state.filterChamp = null;
  _champSel = new Set();
  const btn = document.getElementById('map-champ-btn');
  if (btn) btn.textContent = 'Filtre caractéristique';
  refreshMapMarkers();
  toggleChampPanel();
}
function toggleFilterPanel() {
  document.getElementById('map-filter-panel').classList.toggle('show');
  renderFilterPanel();
}
function toggleAllArmoiresFilter() {
  const all = _armIdsSorted.slice();
  const tousCoches = all.length && (state.filterArmoire || []).length >= all.length;
  state.filterArmoire = tousCoches ? [] : all;   // si déjà tout coché → tout décocher
  _filterSig = '';
  refreshMapMarkers();
  renderFilterPanel();
  zoomToArmoireFilter();
}
function updateMapProgress() {
  const box = document.getElementById('map-progress');
  if (!box) return;
  const ids = (state.filterArmoire && state.filterArmoire.length)
    ? state.filterArmoire.slice()
    : null;   // null = tout le chantier
  let total = 0, faits = 0, titre = '';
  if (ids) {
    ids.forEach(id => { const pr = armoireProgress(id); total += pr.total; faits += pr.faits; });
    titre = ids.length === 1 ? ('Armoire ' + ids[0]) : (ids.length + ' armoires');
  } else {
    (state.points || []).forEach(p => {
      if (state.chantier && String(p.chantier || '') !== String(state.chantier)) return;
      total++; if (p.verifie) faits++;
    });
    titre = 'PEEEPS ' + (state.chantier || '');
  }
  if (!total) { box.classList.remove('show'); return; }
  const pct = Math.round(faits / total * 100);
  const col = pct === 100 ? '#4ade80' : pct >= 50 ? '#e2e8f0' : '#fbbf24';
  box.innerHTML = `<div class="mp-pct" style="color:${col}">${pct}%</div>
    <div class="mp-track"><div class="mp-fill" style="height:${pct}%;background:${col}"></div></div>
    <div class="mp-num">${faits}/${total} vérif.</div>`;
  box.title = titre + ' — ' + faits + '/' + total + ' vérifiés (' + pct + '%)';
  box.classList.add('show');
}
function toggleArmoireInFilter(id) {
  const arr = state.filterArmoire || (state.filterArmoire = []);
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1); else arr.push(id);
  _filterSig = '';
  refreshMapMarkers();
  zoomToArmoireFilter();
}
function clearArmoireFilter() {
  state.filterArmoire = [];
  _filterSig = '';
  refreshMapMarkers();
}
function zoomToArmoireFilter() {
  const sel = _filterSet();
  if (!sel.size) return;
  const latlngs = [];
  state.points.forEach(p => { if (inPeeeps(p) && sel.has(String(p.idArmoire)) && p.lat && p.lng) latlngs.push([p.lat, p.lng]); });
  state.armoires.forEach(a => { if (inPeeeps(a) && sel.has(String(a.id)) && a.lat && a.lng) latlngs.push([a.lat, a.lng]); });
  if (latlngs.length === 1) map.setView(latlngs[0], 18);
  else if (latlngs.length > 1) map.fitBounds(latlngs, { padding: [50, 50], maxZoom: 19 });
}

let mapDirty = false;
function popupPointHTML(id) {
  const pt = state.points.find(p => p.id === id);
  if (!pt) return '';
  return `<div class="popup-id">${escapeHtml(pt.id)}</div>
    <div class="popup-title">${escapeHtml(pt.typeSupport || 'Point lumineux')}</div>
    <div style="font-size:12px;color:#94a3b8">${escapeHtml(pt.technologie || '')} ${pt.puissance ? escapeHtml(pt.puissance) + 'W' : ''}</div>
    <div class="popup-actions">
      <button class="popup-btn popup-btn-edit" onclick="editFromMap('${pt.id}')">Modifier</button>
      <button class="popup-btn popup-btn-move" onclick="moveFromMap('${pt.id}')" title="Déplacer">✥</button>
      <button class="popup-btn popup-btn-del" onclick="deleteFromMap('${pt.id}')" title="Supprimer">🗑</button>
    </div>`;
}
function popupArmoireHTML(id) {
  const arm = state.armoires.find(a => String(a.id) === String(id));
  if (!arm) return '';
  const nbPts = _armCounts ? (_armCounts[String(arm.id).trim()] || 0) : 0;
  return `<div class="popup-id" style="color:#fb923c">${escapeHtml(arm.id)}</div>
    <div class="popup-title">Armoire électrique</div>
    <div style="font-size:12px;color:#94a3b8">${nbPts} point${nbPts > 1 ? 's' : ''} rattaché${nbPts > 1 ? 's' : ''}</div>
    <div class="popup-actions">
      <button class="popup-btn popup-btn-edit" onclick="editArmoireFromMap('${arm.id}')">Modifier</button>
      <button class="popup-btn popup-btn-move" onclick="moveArmoireFromMap('${arm.id}')" title="Déplacer">✥</button>
      <button class="popup-btn popup-btn-del" onclick="deleteArmoireFromMap('${arm.id}')" title="Supprimer">🗑</button>
    </div>`;
}
let _armCounts = null;   // pré-comptage des points par armoire (calculé une fois par refresh)
function refreshMapMarkers() {
  // Pré-compte les points par armoire UNE fois (au lieu d'un filter par armoire = O(n²)).
  _armCounts = {};
  state.points.forEach(p => {
    const a = String(p.idArmoire || '').trim();
    if (a) _armCounts[a] = (_armCounts[a] || 0) + 1;
  });
  if (currentScreen !== 'map') { mapDirty = true; return; }   // reconstruit au retour sur la carte
  mapDirty = false;
  if (!markersLayer) return;
  setTimeout(updateMapProgress, 0);
  markersLayer.clearLayers();
  if (pointsCluster) pointsCluster.clearLayers();
  markersById.clear();
  armoireMarkersById.clear();
  populateArmoireFilter();
  const ptMarkers = [];
  state.points.forEach(pt => {
    if (!pt.lat || !pt.lng) return;
    if (state.chantier && String(pt.chantier || '') !== String(state.chantier)) return;
    if (state.filterArmoire.length && !state.filterArmoire.includes(String(pt.idArmoire))) return;
    if (!champFilterOK(pt)) return;
    const color = getMarkerColor(pt);
    // divIcon (HTML) pour TOUS les points : reçoit le clic de façon fiable ET se regroupe en bulles.
    const marker = L.marker([pt.lat, pt.lng], {
      icon: L.divIcon({ className: 'pt-marker', html: markerShapeHTML(pt, color), iconSize: [18,18], iconAnchor: [9,9] })
    });
    marker._ptId = pt.id;
    marker.bindPopup(() => popupPointHTML(marker._ptId), { maxWidth: 260 });
    markersById.set(pt.id, marker);
    ptMarkers.push(marker);
  });
  // TOUS les points dans le cluster → regroupement en bulles + clic fiable (divIcon).
  if (pointsCluster) {
    if (pointsCluster.addLayers) pointsCluster.addLayers(ptMarkers);
    else ptMarkers.forEach(m => pointsCluster.addLayer(m));
  } else {
    ptMarkers.forEach(m => m.addTo(map));
  }
  // Marqueurs armoires (carré orange avec éclair)
  state.armoires.forEach(arm => {
    if (!arm.lat || !arm.lng) return;
    if (state.chantier && String(arm.chantier || '') !== String(state.chantier)) return;
    if (state.filterArmoire.length && !state.filterArmoire.includes(String(arm.id))) return;
    const icon = L.divIcon({
      className: '',
      html: `<div style="width:22px;height:22px;background:#fb923c;border:2px solid white;border-radius:3px;box-shadow:0 2px 6px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center">
        <svg width="13" height="13" viewBox="0 0 12 12" fill="white"><path d="M7 1L3 7h4l-2 4 6-6H7L9 1z"/></svg>
      </div>`,
      iconSize: [22, 22], iconAnchor: [11, 11]
    });
    const marker = L.marker([arm.lat, arm.lng], { icon, zIndexOffset: 500 }).addTo(markersLayer);
    armoireMarkersById.set(arm.id, marker);
    marker._armId = arm.id;
    marker.bindPopup(() => popupArmoireHTML(marker._armId), { maxWidth: 260 });
  });
  const _fs = _filterSet();
  const shown = _fs.size
    ? state.points.filter(p => inPeeeps(p) && _fs.has(String(p.idArmoire)) && p.lat && p.lng).length
    : peeepsPoints().length;
  const ptsLabel = _fs.size ? (shown + ' pts (filtré)') : (shown + ' pts');
  const armLabel = peeepsArmoires().length + ' arm.';
  document.getElementById('map-count-badge').textContent = ptsLabel + ' · ' + armLabel;
}

let _watchId = null;
let meMarker = null, meAccuracy = null, _meFirstFix = false, _meStaleTimer = null;

function centerOnMe() {
  if (!navigator.geolocation) { showToast('Géolocalisation indisponible', 'error'); return; }
  navigator.geolocation.getCurrentPosition(
    pos => { if (map) map.setView([pos.coords.latitude, pos.coords.longitude], 17); updateMePosition(pos); },
    err => showToast('Position introuvable (' + err.code + ')', 'error'),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
  );
}

function toggleLocationTracking() {
  if (_watchId !== null) { stopLocationTracking(); return; }
  if (!navigator.geolocation) { showToast('Géolocalisation indisponible sur cet appareil', 'error'); return; }
  _meFirstFix = false;
  _watchId = navigator.geolocation.watchPosition(
    pos => updateMePosition(pos, true),
    err => {
      showToast(err.code === 1 ? 'Localisation refusée — autorisez-la dans les réglages'
             : 'Signal GPS faible, on réessaie…', 'error');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 2000 }
  );
  const btn = document.getElementById('track-btn');
  if (btn) btn.classList.add('tracking');
  showToast('Suivi de position activé', 'success');
}

function stopLocationTracking() {
  if (_watchId !== null) { navigator.geolocation.clearWatch(_watchId); _watchId = null; }
  if (meMarker) { map.removeLayer(meMarker); meMarker = null; }
  if (meAccuracy) { map.removeLayer(meAccuracy); meAccuracy = null; }
  if (_meStaleTimer) { clearTimeout(_meStaleTimer); _meStaleTimer = null; }
  const btn = document.getElementById('track-btn');
  if (btn) btn.classList.remove('tracking');
  showToast('Suivi de position désactivé', '');
}

function updateMePosition(pos, recenterFirst) {
  if (!map) return;
  const ll = [pos.coords.latitude, pos.coords.longitude];
  const acc = pos.coords.accuracy || 0;
  // halo de précision
  if (!meAccuracy) {
    meAccuracy = L.circle(ll, { radius: acc, color: '#2f7bff', weight: 1, fillColor: '#2f7bff', fillOpacity: 0.12, interactive: false }).addTo(map);
  } else { meAccuracy.setLatLng(ll); meAccuracy.setRadius(acc); }
  // point bleu
  const icon = L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16,16], iconAnchor: [8,8] });
  if (!meMarker) {
    meMarker = L.marker(ll, { icon, zIndexOffset: 2000, interactive: false }).addTo(map);
  } else { meMarker.setLatLng(ll); }
  // recentre uniquement au premier point (pour ne pas gêner pendant la saisie)
  if (recenterFirst && !_meFirstFix) { map.setView(ll, Math.max(map.getZoom(), 17)); _meFirstFix = true; }
  // marque la position "périmée" (grise) si plus aucune mise à jour pendant 15 s
  if (_meStaleTimer) clearTimeout(_meStaleTimer);
  const dot = meMarker.getElement() && meMarker.getElement().querySelector('.me-dot');
  if (dot) dot.classList.remove('stale');
  _meStaleTimer = setTimeout(() => { const d = meMarker && meMarker.getElement() && meMarker.getElement().querySelector('.me-dot'); if (d) d.classList.add('stale'); }, 15000);
}

function editFromMap(id) {
  const pt = state.points.find(p => p.id === id);
  if (pt) { map.closePopup(); showForm(pt); }
}
function dupFromMap(id) {
  const pt = state.points.find(p => p.id === id);
  if (pt) { map.closePopup(); dupliquerPointData(pt); }
}
function deleteFromMap(id) {
  const pt = state.points.find(p => p.id === id);
  if (!pt) return;
  if (!confirm('Supprimer définitivement le point ' + pt.id + ' ?\nCette action est irréversible sur cet appareil.')) return;
  map.closePopup();
  deletePointLocal(id);
}

// ── Déplacement d'un point directement sur la carte (glisser-déposer du marqueur) ──
function moveFromMap(id) {
  map.closePopup();
  const marker = markersById.get(id);
  if (!marker) return;
  // Si le point est encore dans un cluster (carte trop dézoomée), on zoome dessus
  // d'abord pour l'isoler — sinon impossible de le saisir au doigt précisément.
  if (pointsCluster && typeof pointsCluster.zoomToShowLayer === 'function' && pointsCluster.getVisibleParent
      && pointsCluster.getVisibleParent(marker) !== marker) {
    pointsCluster.zoomToShowLayer(marker, () => enableMarkerDrag(marker, id));
  } else {
    enableMarkerDrag(marker, id);
  }
}

function enableMarkerDrag(marker, id) {
  // CircleMarker (canvas) : pas de drag natif → on déplace au doigt/souris via la carte.
  if (typeof marker.setStyle === 'function' && typeof marker.setIcon !== 'function') {
    marker.setStyle({ fillColor: '#a78bfa', color: '#fff', weight: 3, radius: 10 });
    showToast('Touchez la nouvelle position du point sur la carte', '');
    const onClick = (e) => {
      map.off('click', onClick);
      marker.setLatLng(e.latlng);
      confirmMarkerMove(marker, id);
    };
    map.on('click', onClick);
    return;
  }
  // Marqueur classique (étoile) : drag natif Leaflet.
  marker.setIcon(L.divIcon({
    className: '',
    html: `<div style="width:20px;height:20px;border-radius:50%;background:#a78bfa;border:3px solid white;box-shadow:0 0 0 6px rgba(167,139,250,.3),0 2px 8px rgba(0,0,0,.5)"></div>`,
    iconSize: [20, 20], iconAnchor: [10, 10]
  }));
  marker.dragging.enable();
  showToast('Faites glisser le point à sa position, puis relâchez pour valider', '');
  marker.once('dragend', () => confirmMarkerMove(marker, id));
}

async function confirmMarkerMove(marker, id) {
  if (marker.dragging && typeof marker.dragging.disable === 'function') marker.dragging.disable();
  const { lat, lng } = marker.getLatLng();
  const pt = state.points.find(p => p.id === id);
  if (!pt) { refreshMapMarkers(); return; }
  const before = cloneEntry(pt);
  pt.lat = lat;
  pt.lng = lng;
  pt.sourcePosition = 'Ajustement manuel (carte)';
  pushUndo('Déplacement ' + id, [{ id, before }]);
  saveLocal();
  refreshMapMarkers();
  updateStatus();
  showToast('Position en cours de sync…', '');
  await syncPointToSheets(pt);
}

// ── Déplacement d'une armoire directement sur la carte ──
function moveArmoireFromMap(id) {
  map.closePopup();
  const marker = armoireMarkersById.get(id);
  if (marker) enableArmoireMarkerDrag(marker, id);
}
function enableArmoireMarkerDrag(marker, id) {
  marker.setIcon(L.divIcon({
    className: '',
    html: `<div style="width:24px;height:24px;border-radius:4px;background:#a78bfa;border:3px solid white;box-shadow:0 0 0 6px rgba(167,139,250,.3),0 2px 8px rgba(0,0,0,.5)"></div>`,
    iconSize: [24, 24], iconAnchor: [12, 12]
  }));
  marker.dragging.enable();
  showToast('Glissez l\u2019armoire \u00e0 sa position, puis rel\u00e2chez pour valider', '');
  marker.once('dragend', () => confirmArmoireMove(marker, id));
}
async function confirmArmoireMove(marker, id) {
  marker.dragging.disable();
  const { lat, lng } = marker.getLatLng();
  const arm = state.armoires.find(a => a.id === id);
  if (!arm) { refreshMapMarkers(); return; }
  arm.lat = lat;
  arm.lng = lng;
  saveLocalArmoires();
  refreshMapMarkers();
  updateStatus();
  showToast('Position armoire en cours de sync\u2026', '');
  await syncArmoireToSheets(arm);
}

// Supprime un point localement (et tente la suppression côté serveur).
// NB : sans confirmation que le script Apps Script gère une action 'delete',
// la ligne peut rester dans le Sheet — le tombstone local empêche au moins
// sa réimportation automatique lors d'un prochain sync.
async function deletePointLocal(id) {
  const idx = state.points.findIndex(p => p.id === id);
  if (idx === -1) return;
  const before = cloneEntry(state.points[idx]);
  state.points.splice(idx, 1);
  try { await DB.del('points', id); } catch (e) {}
  try { await DB.del('queue', id); } catch (e) {}
  try { await DB.put('tombstones', { id, ts: Date.now() }); } catch (e) {}
  for (const t of PHOTO_TYPES) { try { await DB.del('photos', id + '__' + t); } catch (e) {} try { await DB.del('photoQueue', id + '__' + t); } catch (e) {} }
  pushUndo('Suppression ' + id, [{ id, before }]);
  refreshMapMarkers();
  renderList();
  renderPanier();
  updateStatus();
  const ok = await sendDeleteToSheets('Points Lumineux', id);
  showToast(ok ? 'Point supprimé ✓' : 'Supprimé localement — sync au retour réseau', ok ? 'success' : '');
}

// ── FORM ──
let editingId = null;
function generateId() {
  // Horodatage (lisibilité/tri) + suffixe aléatoire cryptographique pour
  // éviter toute collision entre deux appareils posant un point au même instant.
  const ts = Date.now().toString(36).toUpperCase().slice(-6);
  let rand;
  if (window.crypto && crypto.getRandomValues) {
    const buf = new Uint8Array(3);
    crypto.getRandomValues(buf);
    rand = Array.from(buf, b => b.toString(36)).join('').toUpperCase().slice(0, 4);
  } else {
    rand = Math.random().toString(36).toUpperCase().slice(2, 6);
  }
  return 'PL-' + ts + '-' + rand;
}

function photoLabel(k) { return k === 'mat' ? 'Mât' : k === 'classe2' ? 'Classe 2' : 'Luminaire'; }
function emptyPhotoSlotHTML(k) {
  return '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="#64748b" stroke-width="1.5"><rect x="2" y="6" width="18" height="13" rx="3"/><circle cx="11" cy="13" r="3"/><path d="M8 6l1.5-3h3L14 6"/></svg><div class="photo-label">' + photoLabel(k) + '</div>';
}
function renderPhotoThumb(k, src) {
  const slot = document.getElementById('photo-' + k);
  if (!slot) return;
  slot.innerHTML = '<img src="' + src + '" alt=""><span class="pbadge">✓</span>';
}

function showForm(pt) {
  editingId = pt ? pt.id : null;
  state.photoBlobs = { luminaire: null, mat: null, classe2: null };
  state.photoExisting = { luminaire: false, mat: false, classe2: false };
  currentGPSLat = null; currentGPSLng = null; currentGPSAccuracy = null; currentSourcePosition = '';
  state.panierInForm = pt ? (pt.dansPanier || false) : false;

  document.getElementById('form-title').textContent = pt ? 'Modifier point' : 'Nouveau point';
  document.getElementById('form-id-text').textContent = pt ? pt.id : '';
  document.getElementById('f-nbr-supports').value = pt ? (pt.nbrSupports || '') : '';
  setFieldValueSmart(document.getElementById('f-type-support'),   pt ? (pt.typeSupport || '') : '');
  setFieldValueSmart(document.getElementById('f-etat-support'),   pt ? (pt.etatSupport || '') : '');
  document.getElementById('f-hauteur').value = pt ? (pt.hauteur || '') : '';
  setFieldValueSmart(document.getElementById('f-type-attache'),   pt ? (pt.typeAttache || '') : '');
  document.getElementById('f-nbr-luminaires').value = pt ? (pt.nbrLuminaires || '') : '';
  setFieldValueSmart(document.getElementById('f-type-luminaire'), pt ? (pt.typeLuminaire || '') : '');
  setFieldValueSmart(document.getElementById('f-etat-luminaire'), pt ? (pt.etatLuminaire || '') : '');
  setFieldValueSmart(document.getElementById('f-technologie'),    pt ? (pt.technologie || '') : '');
  document.getElementById('f-puissance').value = pt ? (pt.puissance || '') : '';
  document.getElementById('f-observations').value = pt ? (pt.observations || '') : '';
  populateIdArmoireSelect(pt ? (pt.idArmoire || '') : '');
  document.getElementById('toggle-depose').classList.toggle('on', !!(pt && pt.aDeposer));
  document.getElementById('toggle-verifie').classList.toggle('on', !!(pt && pt.verifie));
  document.getElementById('f-classe-precision').value = pt ? (pt.classePrecision || 'C') : 'C';
  renderCustomFields();
  applyFieldOrder();          // les champs perso viennent d'être recréés → on replace tout
  (CONFIG.customFields || []).forEach(cf => {
    const el = document.getElementById('cf-' + cf.key);
    if (el) setFieldEl(el, (pt && pt.custom && pt.custom[cf.column] != null) ? pt.custom[cf.column] : '');
  });
  renderTemplatesBar();
  const _fs = document.querySelector('#screen-form .form-scroll');
  if (_fs) _fs.style.borderTop = '';

  const toggle = document.getElementById('toggle-panier');
  toggle.classList.toggle('on', state.panierInForm);

  const gpsEl = document.getElementById('gps-display');
  const accEl = document.getElementById('gps-acc');
  if (pt && pt.lat) {
    gpsEl.textContent = Number(pt.lat).toFixed(6) + ', ' + Number(pt.lng).toFixed(6);
    gpsEl.classList.remove('empty');
    accEl.textContent = pt.gpsAccuracy ? '± ' + Math.round(pt.gpsAccuracy) + ' m' : '± — m';
  } else {
    gpsEl.textContent = 'Appuyer pour capturer';
    gpsEl.classList.add('empty');
    accEl.textContent = '± — m';
    accEl.className = 'acc-tag';
  }

  // vignettes : réinit puis chargement des photos déjà enregistrées (IndexedDB)
  PHOTO_TYPES.forEach((k) => {
    const slot = document.getElementById('photo-' + k);
    slot.innerHTML = emptyPhotoSlotHTML(k);
    slot.onclick = () => takePhoto(k);
    if (pt && pt.photos && pt.photos[k]) {
      state.photoExisting[k] = true;
      getPhotoBlob(pt.id, k).then((blob) => {
        if (blob && editingId === pt.id) renderPhotoThumb(k, URL.createObjectURL(blob));
      }).catch(() => {});
    }
  });

  showScreen('form');
}

let currentGPSLat = null, currentGPSLng = null;
function captureGPS() {
  const btn = document.querySelector('.gps-btn');
  btn.textContent = '⏳ ...';
  navigator.geolocation.getCurrentPosition((pos) => {
    currentGPSLat = pos.coords.latitude;
    currentGPSLng = pos.coords.longitude;
    currentGPSAccuracy = pos.coords.accuracy != null ? Math.round(pos.coords.accuracy) : null;
    currentSourcePosition = 'GPS iPad';
    const el = document.getElementById('gps-display');
    el.textContent = currentGPSLat.toFixed(6) + ', ' + currentGPSLng.toFixed(6);
    el.classList.remove('empty');
    // exactitude + suggestion de classe (jamais A en auto : A = RTK certifié)
    const accEl = document.getElementById('gps-acc');
    if (currentGPSAccuracy != null) {
      accEl.textContent = '± ' + currentGPSAccuracy + ' m';
      accEl.className = 'acc-tag ' + (currentGPSAccuracy <= 2 ? 'good' : currentGPSAccuracy <= 8 ? 'mid' : 'bad');
      const sel = document.getElementById('f-classe-precision');
      if (sel.value !== 'A') sel.value = currentGPSAccuracy <= 1.5 ? 'B' : 'C';
    }
    btn.textContent = '✓ OK';
    setTimeout(() => (btn.textContent = '📍 GPS'), 1500);
    showToast('Position capturée', 'success');
  }, () => {
    btn.textContent = '📍 GPS';
    showToast('GPS indisponible', 'error');
  }, { enableHighAccuracy: true, timeout: 10000 });
}

function togglePanier() {
  state.panierInForm = !state.panierInForm;
  document.getElementById('toggle-panier').classList.toggle('on', state.panierInForm);
}

function takePhoto(type) {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment';
  input.style.display = 'none';
  // OBLIGATOIRE en PWA iOS installée : sans rattachement au DOM, l'événement
  // de retour de l'appareil photo ne se déclenche jamais (photo perdue en silence).
  document.body.appendChild(input);
  const cleanup = () => { try { document.body.removeChild(input); } catch (e) {} };
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) { cleanup(); return; }
    try {
      const blob = await downscaleToBlob(file);   // compression → fini le quota
      state.photoBlobs[type] = blob;               // persistée à l'enregistrement
      renderPhotoThumb(type, URL.createObjectURL(blob));
      showToast('Photo ajoutée — pensez à Enregistrer', 'success');
    } catch (err) {
      console.error('photo', err);
      showToast('Photo illisible, réessayez', 'error');
    }
    cleanup();
  };
  input.click();
}

function getFormData() {
  const existing = editingId ? state.points.find(p => p.id === editingId) : null;
  const lat = currentGPSLat || (existing ? existing.lat : null);
  const lng = currentGPSLng || (existing ? existing.lng : null);
  const gpsAccuracy = currentGPSAccuracy != null ? currentGPSAccuracy : (existing ? (existing.gpsAccuracy != null ? existing.gpsAccuracy : null) : null);
  const sourcePosition = currentSourcePosition || (existing ? (existing.sourcePosition || '') : '') || (lat ? 'GPS iPad' : '');
  const photos = {};
  PHOTO_TYPES.forEach(k => { photos[k] = !!(state.photoBlobs[k] || state.photoExisting[k]); });
  return {
    id: editingId || generateId(),
    chantier: state.chantier,
    technicien: state.technicien,
    date: new Date().toISOString().split('T')[0],
    lat, lng,
    gpsAccuracy,
    sourcePosition,
    idArmoire: document.getElementById('f-id-armoire').value.trim(),
    classePrecision: document.getElementById('f-classe-precision').value,
    nbrSupports: document.getElementById('f-nbr-supports').value,
    typeSupport: document.getElementById('f-type-support').value,
    etatSupport: document.getElementById('f-etat-support').value,
    hauteur: document.getElementById('f-hauteur').value,
    typeAttache: document.getElementById('f-type-attache').value,
    nbrLuminaires: document.getElementById('f-nbr-luminaires').value,
    typeLuminaire: document.getElementById('f-type-luminaire').value,
    etatLuminaire: document.getElementById('f-etat-luminaire').value,
    technologie: document.getElementById('f-technologie').value,
    puissance: document.getElementById('f-puissance').value,
    observations: document.getElementById('f-observations').value,
    dansPanier: state.panierInForm,
    aDeposer: document.getElementById('toggle-depose').classList.contains('on'),
    verifie: document.getElementById('toggle-verifie').classList.contains('on'),
    custom: readCustomFields(),
    photos
  };
}

async function savePoint() {
  const data = getFormData();
  // (aucun champ obligatoire : on peut enregistrer une fiche partielle et la compléter plus tard)
  // Persiste les photos capturées (Blob) en IndexedDB, rattachées à l'ID du point
  try {
    for (const k of PHOTO_TYPES) {
      if (state.photoBlobs[k]) {
        await savePhotoBlob(data.id, k, state.photoBlobs[k]);
        await enqueuePhoto(data.id, k, 'Points Lumineux', PHOTO_COLS[k], data.idArmoire || '');
      }
    }
  } catch (e) { console.error('photo save', e); showToast('⚠ Échec sauvegarde photo', 'error'); }
  const existingIdx = editingId ? state.points.findIndex(p => p.id === editingId) : -1;
  const before = existingIdx >= 0 ? cloneEntry(state.points[existingIdx]) : null;
  if (editingId) {
    if (existingIdx >= 0) state.points[existingIdx] = data; else state.points.push(data);
  } else {
    state.points.push(data);
  }
  pushUndo((before ? 'Modification ' : 'Ajout ') + data.id, [{ id: data.id, before }]);
  currentGPSLat = null; currentGPSLng = null; currentGPSAccuracy = null; currentSourcePosition = '';
  saveLocal();
  await syncPointToSheets(data);
  uploadPendingPhotos();
  refreshMapMarkers();
  updateStatus();
  showToast('Point enregistré ✓', 'success');
  goBack();
}

function dupliquerPoint() {
  const data = getFormData();
  savePoint();
  setTimeout(() => dupliquerPointData(data), 300);
}

function dupliquerPointData(source) {
  editingId = null;
  currentGPSLat = null; currentGPSLng = null; currentGPSAccuracy = null; currentSourcePosition = '';
  state.photoBlobs = { luminaire: null, mat: null, classe2: null };
  state.photoExisting = { luminaire: false, mat: false, classe2: false };
  state.panierInForm = false;

  document.getElementById('form-title').textContent = 'Dupliquer — GPS requis';
  document.getElementById('form-id-label').textContent = 'Nouveau point';
  document.getElementById('f-nbr-supports').value = source.nbrSupports || '';
  setFieldValueSmart(document.getElementById('f-type-support'), source.typeSupport || '');
  setFieldValueSmart(document.getElementById('f-etat-support'), source.etatSupport || '');
  document.getElementById('f-hauteur').value = source.hauteur || '';
  setFieldValueSmart(document.getElementById('f-type-attache'), source.typeAttache || '');
  document.getElementById('f-nbr-luminaires').value = source.nbrLuminaires || '';
  document.getElementById('f-type-luminaire').value = '';
  document.getElementById('f-etat-luminaire').value = '';
  document.getElementById('f-technologie').value = '';
  document.getElementById('f-puissance').value = '';
  document.getElementById('f-observations').value = '';
  document.getElementById('toggle-panier').classList.remove('on');

  const gpsEl = document.getElementById('gps-display');
  gpsEl.textContent = 'Appuyer pour capturer';
  gpsEl.classList.add('empty');

  ['luminaire','mat','classe2'].forEach(k => {
    const slot = document.getElementById('photo-' + k);
    slot.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="#64748b" stroke-width="1.5"><rect x="2" y="6" width="18" height="13" rx="3"/><circle cx="11" cy="13" r="3"/><path d="M8 6l1.5-3h3L14 6"/></svg><div class="photo-label">${k==='mat'?'Mât':k==='classe2'?'Classe 2':'Luminaire'}</div>`;
    slot.onclick = () => takePhoto(k);
  });

  showScreen('form');
  showToast('Champs copiés — capturez le GPS', 'success');
  setTimeout(() => captureGPS(), 500);
}

// ── LIST ──
// ══════════════════════════════════════════
// MODULE ARMOIRES
// ══════════════════════════════════════════
const ARM_PHOTO_TYPES = ['arm_ext', 'arm_int', 'arm_compteur'];
function armPhotoLabel(k) {
  return k === 'arm_ext' ? 'Extérieur' : k === 'arm_int' ? 'Intérieur' : 'Compteur';
}

let editingArmoireId = null;
let armGPSLat = null, armGPSLng = null;

function generateArmoireId() {
  const existing = state.armoires.map(a => a.id);
  for (let i = 1; i <= 999; i++) {
    const candidate = 'ARM-' + String(i).padStart(3, '0');
    if (!existing.includes(candidate)) return candidate;
  }
  return 'ARM-' + Date.now().toString(36).toUpperCase().slice(-4);
}

// Progression de vérification d'une armoire : { total, faits, pct }
function armoireProgress(armId) {
  const id = String(armId).trim();
  let total = 0, faits = 0;
  (state.points || []).forEach(p => {
    if (String(p.idArmoire || '').trim() !== id) return;
    if (state.chantier && String(p.chantier || '') !== String(state.chantier)) return;
    total++;
    if (p.verifie) faits++;
  });
  return { total, faits, pct: total ? Math.round(faits / total * 100) : 0 };
}
function progressBarHTML(pr, compact) {
  const col = pr.pct === 100 ? '#4ade80' : pr.pct >= 50 ? '#e2e8f0' : '#fbbf24';
  return `<div class="prog-wrap${compact ? ' prog-compact' : ''}">
    <div class="prog-track"><div class="prog-fill" style="width:${pr.pct}%;background:${col}"></div></div>
    <div class="prog-lbl">${pr.faits}/${pr.total} vérifiés · ${pr.pct}%</div>
  </div>`;
}
function renderArmoires() {
  const scroll = document.getElementById('armoires-scroll');
  const sub = document.getElementById('armoires-sub');
  const searchEl = document.getElementById('arm-search');
  const filterEl = document.getElementById('arm-filter-etat');
  const q = searchEl ? searchNorm(searchEl.value.trim()) : '';
  const etatFilter = filterEl ? filterEl.value : '';
  const baseArm = peeepsArmoires();
  let source = baseArm;
  if (etatFilter) source = source.filter(a => a.etatExt === etatFilter);
  if (q) {
    source = source.filter(a => {
      const hay = searchNorm([a.id, a.cable, a.observations, a.departs, a.protection, a.horloge, a.abonnement].join(' '));
      return hay.includes(q);
    });
  }
  sub.textContent = (q || etatFilter ? source.length + ' / ' + baseArm.length : baseArm.length) + ' armoire' + (baseArm.length > 1 ? 's' : '');
  if (!source.length) {
    scroll.innerHTML = (q || etatFilter)
      ? `<div class="search-empty-hint">Aucune armoire ne correspond${q ? ' à « ' + escapeHtml(searchEl.value.trim()) + ' »' : ''}${etatFilter ? ' (état : ' + escapeHtml(etatFilter) + ')' : ''}</div>`
      : '<div style="text-align:center;padding:40px 20px;color:var(--text3)"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" style="opacity:.3;margin-bottom:12px"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg><div>Aucune armoire enregistrée</div><div style="font-size:12px;margin-top:6px">Appuyez sur « Ajouter » pour commencer</div></div>';
    return;
  }
  scroll.innerHTML = source.map(arm => {
    const nbPts = state.points.filter(p => inPeeeps(p) && String(p.idArmoire || '').trim() === String(arm.id).trim()).length;
    const etatColor = arm.etatExt === 'Bon' ? '#4ade80' : arm.etatExt === 'Moyen' ? '#facc15' : arm.etatExt ? '#f87171' : '#64748b';
    return `<div class="armoire-card">
      <div class="armoire-item" onclick="showArmoireForm(state.armoires.find(a=>a.id==='${arm.id}'))">
      <div class="armoire-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fb923c" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/><path d="M12 14h.01M12 17h.01"/></svg>
      </div>
      <div class="armoire-item-body">
        <div class="armoire-item-id">${escapeHtml(arm.id)}</div>
        <div class="armoire-item-sub">
          <span style="color:${etatColor}">${arm.etatExt || '—'}</span>
          ${arm.cable ? ' · ' + escapeHtml(arm.cable) : ''}
          ${arm.abonnement ? ' · ' + arm.abonnement + ' kVA' : ''}
        </div>
      </div>
      <div class="armoire-item-badge">${nbPts} pts</div>
      <button class="armoire-del" onclick="event.stopPropagation();deleteArmoireFromList('${arm.id}')" title="Supprimer l'armoire">🗑</button>
      </div>
      ${progressBarHTML(armoireProgress(arm.id))}
    </div>`;
  }).join('');
}

function deleteArmoireFromList(id) {
  if (!confirm('Supprimer l\u2019armoire « ' + id + ' » ?\nSes points lumineux ne sont pas supprimés (seul le coffret disparaît).')) return;
  if (typeof deleteArmoireFromMap === 'function') { deleteArmoireFromMap(id); }
  else {
    state.armoires = state.armoires.filter(a => String(a.id) !== String(id));
    DB.put('tombstones', { id: 'ARM__' + id, ts: Date.now() }).catch(() => {});
    saveLocalArmoires(); sendDeleteToSheets('Armoires', id); refreshMapMarkers();
  }
  renderArmoires();
  showToast('Armoire « ' + id + ' » supprimée', 'success');
}
function showArmoireForm(arm) {
  editingArmoireId = arm ? arm.id : null;
  armGPSLat = arm ? arm.lat : null;
  armGPSLng = arm ? arm.lng : null;
  state.armoirePhotoBlobs = { arm_ext: null, arm_int: null, arm_compteur: null };
  state.armoirePhotoExisting = { arm_ext: false, arm_int: false, arm_compteur: false };

  document.getElementById('armoire-form-title').textContent = arm ? 'Modifier armoire' : 'Nouvelle armoire';
  document.getElementById('armoire-form-id-label').textContent = arm ? arm.id : '';
  document.getElementById('af-id').value = arm ? arm.id : generateArmoireId();
  document.getElementById('af-etat-ext').value = arm ? (arm.etatExt || '') : '';
  document.getElementById('af-etat-int').value = arm ? (arm.etatInt || '') : '';
  document.getElementById('af-abonnement').value = arm ? (arm.abonnement || '') : '';
  document.getElementById('af-cable').value = arm ? (arm.cable || '') : '';
  document.getElementById('af-departs').value = arm ? (arm.departs || '') : '';
  document.getElementById('af-protection').value = arm ? (arm.protection || '') : '';
  document.getElementById('af-horloge').value = arm ? (arm.horloge || '') : '';
  document.getElementById('af-observations').value = arm ? (arm.observations || '') : '';
  renderArmCustomFields();
  (CONFIG.armCustomFields || []).forEach(cf => {
    const el = document.getElementById('acf-' + cf.key);
    if (el) setFieldEl(el, (arm && arm.custom && arm.custom[cf.column] != null) ? arm.custom[cf.column] : '');
  });

  const gpsEl = document.getElementById('arm-gps-display');
  if (arm && arm.lat) {
    gpsEl.textContent = Number(arm.lat).toFixed(6) + ', ' + Number(arm.lng).toFixed(6);
    gpsEl.classList.remove('empty');
  } else {
    gpsEl.textContent = 'Appuyer pour capturer';
    gpsEl.classList.add('empty');
  }

  ARM_PHOTO_TYPES.forEach(k => {
    const slot = document.getElementById('photo-' + k);
    if (!slot) return;
    slot.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="#64748b" stroke-width="1.5"><rect x="2" y="6" width="18" height="13" rx="3"/><circle cx="11" cy="13" r="3"/><path d="M8 6l1.5-3h3L14 6"/></svg><div class="photo-label">${armPhotoLabel(k)}</div>`;
    slot.onclick = () => takeArmoirePhoto(k);
    if (arm && arm.photos && arm.photos[k]) {
      state.armoirePhotoExisting[k] = true;
      getPhotoBlob(arm.id, k).then(blob => {
        if (blob && editingArmoireId === arm.id) {
          slot.innerHTML = '<img src="' + URL.createObjectURL(blob) + '" alt=""><span class="pbadge">✓</span>';
        }
      }).catch(() => {});
    }
  });

  showScreen('armoire-form');
}

async function saveArmoire() {
  const id = document.getElementById('af-id').value.trim().toUpperCase();
  if (!id) { id = 'ARM-' + Date.now().toString().slice(-6); }   // ID auto si laissé vide (aucune obligation)
  const photos = {};
  ARM_PHOTO_TYPES.forEach(k => { photos[k] = !!(state.armoirePhotoBlobs[k] || state.armoirePhotoExisting[k]); });
  const arm = {
    id,
    chantier: state.chantier,
    technicien: state.technicien,
    date: new Date().toISOString().slice(0, 10),
    lat: armGPSLat || (editingArmoireId ? (state.armoires.find(a => a.id === editingArmoireId) || {}).lat : null),
    lng: armGPSLng || (editingArmoireId ? (state.armoires.find(a => a.id === editingArmoireId) || {}).lng : null),
    etatExt: document.getElementById('af-etat-ext').value,
    etatInt: document.getElementById('af-etat-int').value,
    abonnement: document.getElementById('af-abonnement').value,
    cable: document.getElementById('af-cable').value,
    departs: document.getElementById('af-departs').value,
    protection: document.getElementById('af-protection').value,
    horloge: document.getElementById('af-horloge').value,
    observations: document.getElementById('af-observations').value,
    custom: readArmCustomFields(),
    photos
  };

  // Sauvegarde photos
  for (const k of ARM_PHOTO_TYPES) {
    if (state.armoirePhotoBlobs[k]) {
      await savePhotoBlob(arm.id, k, state.armoirePhotoBlobs[k]).catch(e => console.error('photo armoire', e));
      await enqueuePhoto(arm.id, k, 'Armoires', ARM_PHOTO_COLS[k], arm.id);
    }
  }

  const idx = state.armoires.findIndex(a => a.id === editingArmoireId);
  if (idx >= 0) {
    // Si l'ID a changé, nettoyer les points rattachés à l'ancien ID
    if (editingArmoireId && editingArmoireId !== id) {
      state.points.forEach(p => { if (p.idArmoire === editingArmoireId) p.idArmoire = id; });
      saveLocal();
    }
    state.armoires[idx] = arm;
  } else {
    state.armoires.push(arm);
  }
  saveLocalArmoires();
  refreshMapMarkers();
  await syncArmoireToSheets(arm);
  uploadPendingPhotos();
  showToast(editingArmoireId ? 'Armoire mise à jour' : 'Armoire enregistrée', 'success');
  showScreen('armoires');
}

function captureGPSArmoire() {
  const btn = document.querySelector('#screen-armoire-form .gps-btn');
  btn.textContent = '⏳ ...';
  navigator.geolocation.getCurrentPosition(pos => {
    armGPSLat = pos.coords.latitude;
    armGPSLng = pos.coords.longitude;
    const el = document.getElementById('arm-gps-display');
    el.textContent = armGPSLat.toFixed(6) + ', ' + armGPSLng.toFixed(6);
    el.classList.remove('empty');
    btn.textContent = '✓ OK';
    setTimeout(() => btn.textContent = '📍 GPS', 1500);
    showToast('Position capturée', 'success');
  }, () => { btn.textContent = '📍 GPS'; showToast('GPS indisponible', 'error'); },
  { enableHighAccuracy: true, timeout: 10000 });
}

function takeArmoirePhoto(type) {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment';
  input.style.display = 'none';
  document.body.appendChild(input);   // idem : indispensable en PWA iOS installée
  const cleanup = () => { try { document.body.removeChild(input); } catch (e) {} };
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) { cleanup(); return; }
    try {
      const blob = await downscaleToBlob(file);
      state.armoirePhotoBlobs[type] = blob;
      const slot = document.getElementById('photo-' + type);
      if (slot) slot.innerHTML = '<img src="' + URL.createObjectURL(blob) + '" alt=""><span class="pbadge">✓</span>';
      showToast('Photo ajoutée — pensez à Enregistrer', 'success');
    } catch { showToast('Photo illisible, réessayez', 'error'); }
    cleanup();
  };
  input.click();
}

function editArmoireFromMap(id) {
  const arm = state.armoires.find(a => a.id === id);
  if (arm) { map.closePopup(); showArmoireForm(arm); }
}

function deleteArmoireFromMap(id) {
  const arm = state.armoires.find(a => a.id === id);
  if (!arm) return;
  if (!confirm('Supprimer définitivement l\'armoire ' + arm.id + ' ?\nLes points lumineux rattachés ne seront pas supprimés.')) return;
  map.closePopup();
  state.armoires = state.armoires.filter(a => a.id !== id);
  DB.put('tombstones', { id: 'ARM__' + id, ts: Date.now() }).catch(() => {});
  ARM_PHOTO_TYPES.forEach(k => { DB.del('photos', id + '__' + k).catch(() => {}); DB.del('photoQueue', id + '__' + k).catch(() => {}); });
  saveLocalArmoires();
  refreshMapMarkers();
  sendDeleteToSheets('Armoires', id).then(ok => {
    showToast(ok ? 'Armoire supprimée ✓' : 'Armoire supprimée — sync au retour réseau', ok ? 'success' : '');
  });
}

function renderList() {
  const scroll = document.getElementById('list-scroll');
  const searchEl = document.getElementById('list-search');
  const q = searchEl ? searchNorm(searchEl.value.trim()) : '';
  const base = peeepsPoints();
  const source = q
    ? base.filter(pt => {
        const hay = searchNorm([pt.id, pt.typeSupport, pt.technologie, pt.etatSupport, pt.puissance, pt.typeLuminaire, pt.idArmoire, pt.hauteur].join(' '));
        return hay.includes(q);
      })
    : base;
  document.getElementById('list-sub').textContent = (q ? source.length + ' / ' + base.length : base.length) + ' points · ' + state.chantier;
  if (!source.length) {
    scroll.innerHTML = q
      ? `<div class="search-empty-hint">Aucun point ne correspond à « ${escapeHtml(searchEl.value.trim())} »</div>`
      : `<div class="empty-state"><div class="empty-icon"><svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#94a3b8" stroke-width="1.5"><circle cx="24" cy="24" r="20"/><path d="M24 14v10l6 6"/></svg></div><div class="empty-text">Aucun point relevé<br>sur ce PEEEPS</div></div>`;
    return;
  }
  const LIST_PAGE = 300;
  if (!window._listLimit) window._listLimit = LIST_PAGE;
  const visible = source.slice(0, window._listLimit);
  const rest = source.length - visible.length;
  scroll.innerHTML = visible.map(pt => `
    <div class="list-item" onclick="showForm(state.points.find(p=>p.id==='${pt.id}'))">
      <div class="list-item-dot" style="background:${getMarkerColor(pt).fill};border:2px solid ${getMarkerColor(pt).border}"></div>
      <div class="list-item-info">
        <div class="list-item-id">${escapeHtml(pt.id)}</div>
        <div class="list-item-title">${escapeHtml(pt.typeSupport || 'Point lumineux')}</div>
        <div class="list-item-sub">${escapeHtml(pt.technologie || '—')} · ${pt.puissance ? escapeHtml(pt.puissance)+'W' : '—'} · ${escapeHtml(pt.etatSupport || '—')}</div>
      </div>
      ${pt.dansPanier ? '<div class="panier-badge">Panier</div>' : ''}
      <div class="list-item-arrow">›</div>
    </div>
  `).join('') + (rest > 0 ? `<button class="set-btn" style="display:block;margin:14px auto 20px" onclick="window._listLimit += 500; renderList()">Afficher plus (${rest} restants)</button>` : '');
}

// ── PANIER ──
function renderPanier() {
  const pts = panierPoints();
  document.getElementById('panier-sub').textContent = pts.length + ' point' + (pts.length>1?'s':'') + ' sélectionné' + (pts.length>1?'s':'');
  document.getElementById('masse-count').textContent = pts.length;
  const scroll = document.getElementById('panier-scroll');
  if (!pts.length) {
    scroll.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#94a3b8" stroke-width="1.5"><path d="M12 4L6 12v28a4 4 0 004 4h28a4 4 0 004-4V12l-6-8zM6 12h36"/><path d="M32 20a8 8 0 01-16 0"/></svg></div><div class="empty-text">Panier vide<br>Cochez "Dans le panier" sur les points à modifier en masse</div></div>`;
    return;
  }
  scroll.innerHTML = pts.map(pt => `
    <div class="list-item">
      <div class="list-item-dot" style="background:${getMarkerColor(pt).fill};border:2px solid ${getMarkerColor(pt).border}"></div>
      <div class="list-item-info">
        <div class="list-item-id">${escapeHtml(pt.id)}</div>
        <div class="list-item-title">${escapeHtml(pt.typeSupport || 'Point lumineux')}</div>
        <div class="list-item-sub">${escapeHtml(pt.technologie || '—')} · ${pt.puissance ? escapeHtml(pt.puissance)+'W' : '—'}</div>
      </div>
      <div onclick="retirerDuPanier('${pt.id}')" style="color:var(--red);font-size:18px;padding:4px 8px;cursor:pointer">×</div>
    </div>
  `).join('');
}

function retirerDuPanier(id) {
  const pt = state.points.find(p => p.id === id);
  if (pt) { pt.dansPanier = false; saveLocal(); renderPanier(); refreshMapMarkers(); }
}

function viderPanier() {
  panierPoints().forEach(p => p.dansPanier = false);
  saveLocal(); renderPanier(); refreshMapMarkers();
  showToast('Panier vidé');
}

// ── MODAL MASSE ──
/* ═══════════ CONFIG MODIFIABLE (page Réglages) ═══════════ */
const CONFIG_DEFAULT = {
  lists: {
    etatSupport: ['BON', 'MOYEN', 'VETUSTE', 'INÉVALUABLE', 'ACCIDENTE', 'MANQUANT'],
    etatLuminaire: ['BON', 'MOYEN', 'VETUSTE', 'INÉVALUABLE', 'ACCIDENTE', 'MANQUANT'],
    technologie: ['SHP', 'BF', 'IM', 'LED', 'CW', 'SBP', 'Ampoule LED', 'TF', 'VM', 'HAL', 'FC', 'AUTRE'],
    typeLuminaire: ['Fonctionnel', 'Résidentiel', 'Piétonnier', 'Design', 'Solaire', 'Balisage', 'Mise en valeur', 'ROUTIERE', 'AMBIANCE', 'BOULE', 'BORNE', 'PROJECTEUR', 'AUTRE'],
    hauteur: ['0m', '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '10m & +', 'Non définis'],
    typeAttache: ['Top', 'Crosse', 'Sans attache', 'Contre-feu', 'AUCUNE', 'CONSOLE', 'SIMPLE', 'DOUBLE', 'TRIPLE', 'QUADRUPLE'],
    typeSupport: ['Mât', 'PBA', 'Mur façade', 'Contre-feu', 'Borne', 'Plot', 'Spot', 'Colonne', 'Mât droit', 'Console', 'Potence', 'Candélabre', 'Encastré sol', 'Façade', 'Sol'],
    cableAlim: ['Aérien', 'Souterrain', 'Mixte'],
    etatCable: ['BON', 'MOYEN', 'VETUSTE']
  },
  customFields: [
    { key: 'solaire', label: 'Solaire', column: 'Solaire', type: 'select',
      options: ['Solaire faisable', 'Solaire infaisable', 'Solaire à projeter'] },
    { key: 'categorielampadaire', label: 'Catégorie', column: 'Catégorie', type: 'trames', options: [] },
    { key: 'marqueluminaire', label: 'Marque luminaire', column: 'Marque luminaire', type: 'text', options: [] },
    { key: 'gammeluminaire', label: 'Gamme luminaire', column: 'Gamme luminaire', type: 'text', options: [] }
  ],
  armCustomFields: [],  // champs personnalisés des armoires (onglet Armoires)
  colorField: 'etatSupport', // quel champ du point déclenche la couleur sur la carte
  colors: {
    'Bon': { fill: '#4ade80', border: '#ffffff' },
    'Moyen': { fill: '#facc15', border: '#ffffff' },
    'Mauvais': { fill: '#f87171', border: '#ffffff' },
    'À remplacer': { fill: '#f87171', border: '#ffffff' },
    '_default': { fill: '#e2e8f0', border: '#ffffff' }
  },
  orderPL: [],    // ordre des champs de la fiche point (vide = ordre d'origine)
  orderARM: [],   // ordre des champs de la fiche armoire
  templates: [],  // trames de fiche : { key, name, thumb, values, custom }
  chantiers: ['Guadeloupe', 'Ménilles', 'Béziers Sud', 'Montpellier Est', 'Nîmes Centre'],
  updatedAt: 0    // horodatage pour la synchro des réglages entre appareils
};
// Correspondance : clé config → <select> du formulaire → libellé lisible
const LIST_FIELDS = [
  { key:'typeSupport',   selectId:'f-type-support',   label:'Types de support' },
  { key:'etatSupport',   selectId:'f-etat-support',   label:'État du support' },
  { key:'typeAttache',   selectId:'f-type-attache',   label:"Types d'attache" },
  { key:'typeLuminaire', selectId:'f-type-luminaire', label:'Types de luminaire' },
  { key:'etatLuminaire', selectId:'f-etat-luminaire', label:'État luminaires' },
  { key:'technologie',   selectId:'f-technologie',    label:'Technologie' },
];
const ARM_LIST_FIELDS = [
  { key:'armEtatExt',    selectId:'af-etat-ext',   label:'Armoire — État extérieur' },
  { key:'armEtatInt',    selectId:'af-etat-int',   label:'Armoire — État intérieur' },
  { key:'armCable',      selectId:'af-cable',      label:"Armoire — Câble d'alimentation" },
  { key:'armProtection', selectId:'af-protection', label:'Armoire — Protection' },
  { key:'armHorloge',    selectId:'af-horloge',    label:'Armoire — Horloge / Télégestion' },
];
let CONFIG = JSON.parse(JSON.stringify(CONFIG_DEFAULT));

async function loadConfig() {
  try {
    const rec = await DB.get('meta', 'config');
    if (rec && rec.v) {
      CONFIG = {
        lists: Object.assign({}, CONFIG_DEFAULT.lists, rec.v.lists || {}),
        customFields: Array.isArray(rec.v.customFields) ? rec.v.customFields : [],
        armCustomFields: Array.isArray(rec.v.armCustomFields) ? rec.v.armCustomFields : [],
        colorField: rec.v.colorField || CONFIG_DEFAULT.colorField,
        colors: Object.assign({}, CONFIG_DEFAULT.colors, rec.v.colors || {}),
        orderPL: Array.isArray(rec.v.orderPL) ? rec.v.orderPL : [],
        orderARM: Array.isArray(rec.v.orderARM) ? rec.v.orderARM : [],
        templates: Array.isArray(rec.v.templates) ? rec.v.templates : [],
        chantiers: Array.isArray(rec.v.chantiers) && rec.v.chantiers.length ? rec.v.chantiers : CONFIG_DEFAULT.chantiers.slice(),
        updatedAt: Number(rec.v.updatedAt) || 0
      };
    }
  } catch (e) {}
  // Garantit la présence des champs personnalisés fournis par défaut (ex : Solaire)
  (CONFIG_DEFAULT.customFields || []).forEach(def => {
    if (!CONFIG.customFields.some(c => c.key === def.key)) CONFIG.customFields.push(def);
  });
  if (!Array.isArray(CONFIG.armCustomFields)) CONFIG.armCustomFields = [];
  if (!CONFIG.colorField) CONFIG.colorField = CONFIG_DEFAULT.colorField;
  if (!CONFIG.colors) CONFIG.colors = Object.assign({}, CONFIG_DEFAULT.colors);
  // Migration : anciennes couleurs stockées en simple string hex → {fill, border}
  Object.keys(CONFIG.colors).forEach(k => {
    if (typeof CONFIG.colors[k] === 'string') {
      CONFIG.colors[k] = { fill: CONFIG.colors[k], border: '#ffffff' };
    }
  });
  if (!Array.isArray(CONFIG.orderPL)) CONFIG.orderPL = [];
  if (!Array.isArray(CONFIG.orderARM)) CONFIG.orderARM = [];
  if (!Array.isArray(CONFIG.templates)) CONFIG.templates = [];
  // Doublons de champs personnalisés (accumulés au fil des fusions) → on ne garde que le premier
  ['customFields', 'armCustomFields'].forEach(prop => {
    if (!Array.isArray(CONFIG[prop])) return;
    const vus = new Set(); const propres = [];
    CONFIG[prop].forEach(cf => {
      const cle = String(cf.column || cf.key || '').toLowerCase().trim();
      if (!cle || vus.has(cle)) return;
      vus.add(cle);
      propres.push(cf);
    });
    if (propres.length !== CONFIG[prop].length) CONFIG[prop] = propres;
  });
  if (!CONFIG.updatedAt) {
    // Config d'avant le partage : horodatage NEUTRE (1) — elle peut amorcer l'onglet Config
    // s'il est vide, mais ne peut JAMAIS écraser une config réellement enregistrée ailleurs.
    CONFIG.updatedAt = 1;
    try { await DB.put('meta', { k: 'config', v: CONFIG }); } catch (e) {}
  }
  applyConfig();
}
async function saveConfig() {
  CONFIG.updatedAt = Date.now();
  try { await DB.put('meta', { k: 'config', v: CONFIG }); } catch (e) {}
  applyConfig();
  pushConfigToSheets();          // partage les réglages avec les autres appareils
}
function fillSelect(sel, options) {
  if (!sel) return;
  const val = sel.value;
  sel.innerHTML = '<option value="">-- Sélectionner --</option>' +
    (options || []).map(o => `<option${o === val ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('');
}
function applyConfig() {
  // 1) menus du formulaire point lumineux
  LIST_FIELDS.forEach(f => fillSelect(document.getElementById(f.selectId), CONFIG.lists[f.key]));
  // 2) édition en masse (mêmes listes)
  masseOptions = {
    'f-type-support': CONFIG.lists.typeSupport,
    'f-type-attache': CONFIG.lists.typeAttache,
    'f-etat-support': CONFIG.lists.etatSupport,
    'f-etat-luminaire': CONFIG.lists.etatLuminaire,
    'f-technologie': CONFIG.lists.technologie,
    'f-type-luminaire': CONFIG.lists.typeLuminaire,
    'f-classe-precision': ['C','B','A'],
  };
  // 3) menus du formulaire armoire
  ARM_LIST_FIELDS.forEach(f => fillSelect(document.getElementById(f.selectId), CONFIG.lists[f.key]));
  // 4) champs personnalisés (points + armoires)
  renderCustomFields();
  renderArmCustomFields();
  // 5) ordre des champs dans les deux fiches
  applyFieldOrder();
  // 6) bandeau des trames de la fiche point
  renderTemplatesBar();
  populateMapPeeepsSwitch();   // la liste des PEEEPS peut venir d'une synchro des réglages
}
// Rend les champs personnalisés dans le formulaire point lumineux
function renderCustomFields() {
  const box = document.getElementById('custom-fields-pl');
  if (!box) return;
  (CONFIG.customFields || []).forEach(cf => {
    document.querySelectorAll('#screen-form #cf-' + CSS.escape(cf.key)).forEach(el => {
      const row = el.closest('.form-row'); if (row && !box.contains(row)) row.remove();
    });
  });
  box.innerHTML = (CONFIG.customFields || []).map(cf => {
    const id = 'cf-' + cf.key;
    const col = escapeHtml(cf.column);
    if (cf.type === 'multi') {
      const chips = (cf.options || []).map(o => `<span class="mchip" data-v="${escapeHtml(o)}" onclick="toggleChip(this)">${escapeHtml(o)}</span>`).join('');
      return `<div class="form-row"><div class="form-label">${escapeHtml(cf.label)}</div><div class="multi-chips" id="${id}" data-col="${col}">${chips}</div></div>`;
    }
    if (cf.type === 'trames') {
      const noms = (typeof getAllTemplates === 'function' ? getAllTemplates() : []).map(t => t.name);
      const optsT = '<option value=""></option>' + noms.map(o => `<option>${escapeHtml(o)}</option>`).join('');
      return `<div class="form-row"><div class="form-label">${escapeHtml(cf.label)}</div><select class="form-select" id="${id}" data-col="${col}">${optsT}</select></div>`;
    }
    if (cf.type === 'select') {
      const opts = '<option value=""></option>' + (cf.options || []).map(o => `<option>${escapeHtml(o)}</option>`).join('');
      return `<div class="form-row"><div class="form-label">${escapeHtml(cf.label)}</div><select class="form-select" id="${id}" data-col="${col}">${opts}</select></div>`;
    }
    return `<div class="form-row"><div class="form-label">${escapeHtml(cf.label)}</div><input class="form-input" id="${id}" data-col="${col}"></div>`;
  }).join('');
}
// Lit les valeurs des champs personnalisés → objet { colonne: valeur }
function readCustomFields() {
  const out = {};
  const cols = new Set((CONFIG.customFields || []).map(cf => cf.column));
  document.querySelectorAll('#screen-form [data-col]').forEach(el => {
    const col = el.getAttribute('data-col');
    if (cols.has(col)) out[col] = readFieldEl(el);
  });
  return out;
}
function renderArmCustomFields() {
  const box = document.getElementById('custom-fields-arm');
  if (!box) return;
  // Anti-doublon : retirer d'éventuels champs perso déplacés hors du conteneur lors d'une réorganisation.
  (CONFIG.armCustomFields || []).forEach(cf => {
    document.querySelectorAll('#screen-armoire-form #acf-' + CSS.escape(cf.key)).forEach(el => {
      const row = el.closest('.form-row'); if (row && !box.contains(row)) row.remove();
    });
  });
  box.innerHTML = (CONFIG.armCustomFields || []).map(cf => {
    const id = 'acf-' + cf.key;
    const col = escapeHtml(cf.column);
    if (cf.type === 'multi') {
      const chips = (cf.options || []).map(o => `<span class="mchip" data-v="${escapeHtml(o)}" onclick="toggleChip(this)">${escapeHtml(o)}</span>`).join('');
      return `<div class="form-row"><div class="form-label">${escapeHtml(cf.label)}</div><div class="multi-chips" id="${id}" data-col="${col}">${chips}</div></div>`;
    }
    if (cf.type === 'trames') {
      const noms = (typeof getAllTemplates === 'function' ? getAllTemplates() : []).map(t => t.name);
      const optsT = '<option value=""></option>' + noms.map(o => `<option>${escapeHtml(o)}</option>`).join('');
      return `<div class="form-row"><div class="form-label">${escapeHtml(cf.label)}</div><select class="form-select" id="${id}" data-col="${col}">${optsT}</select></div>`;
    }
    if (cf.type === 'select') {
      const opts = '<option value=""></option>' + (cf.options || []).map(o => `<option>${escapeHtml(o)}</option>`).join('');
      return `<div class="form-row"><div class="form-label">${escapeHtml(cf.label)}</div><select class="form-select" id="${id}" data-col="${col}">${opts}</select></div>`;
    }
    return `<div class="form-row"><div class="form-label">${escapeHtml(cf.label)}</div><input class="form-input" id="${id}" data-col="${col}"></div>`;
  }).join('');
}
function readArmCustomFields() {
  const out = {};
  const cols = new Set((CONFIG.armCustomFields || []).map(cf => cf.column));
  document.querySelectorAll('#screen-armoire-form [data-col]').forEach(el => {
    const col = el.getAttribute('data-col');
    if (cols.has(col)) out[col] = readFieldEl(el);
  });
  return out;
}
// ── Helpers champs à choix multiples (puces) ──
function toggleChip(el) { el.classList.toggle('on'); }
function readFieldEl(el) {
  if (!el) return '';
  if (el.classList.contains('multi-chips'))
    return [...el.querySelectorAll('.mchip.on')].map(c => c.dataset.v).join(', ');
  if (el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value;
  return el.textContent || '';
}
function setFieldEl(el, val) {
  if (el.classList.contains('multi-chips')) {
    const set = new Set(String(val || '').split(',').map(x => x.trim()).filter(Boolean));
    el.querySelectorAll('.mchip').forEach(c => c.classList.toggle('on', set.has(c.dataset.v)));
  } else el.value = val || '';
}
// ── Liste déroulante des armoires dans la fiche point ──
async function renamePoint() {
  if (!editingId) { showToast('Enregistrez d\u2019abord le point', ''); return; }
  const nouv = (prompt('Nouveau nom / identifiant du point :', editingId) || '').trim();
  if (!nouv || nouv === editingId) return;
  if (state.points.some(p => p.id === nouv)) { showToast('Cet identifiant existe déjà', 'error'); return; }
  const pt = state.points.find(p => p.id === editingId);
  if (!pt) return;
  const ancien = editingId;
  // supprime l'ancienne ligne côté serveur, recrée sous le nouveau nom
  try { await DB.put('tombstones', { id: ancien, ts: Date.now() }); } catch (e) {}
  sendDeleteToSheets('Points Lumineux', ancien);
  pt.id = nouv;
  editingId = nouv;
  document.getElementById('form-id-text').textContent = nouv;
  try { await DB.del('points', ancien); } catch (e) {}
  saveLocal();
  await syncPointToSheets(pt);
  refreshMapMarkers();
  showToast('Point renommé en ' + nouv, 'success');
}
function populateIdArmoireSelect(cur) {
  const sel = document.getElementById('f-id-armoire');
  if (!sel) return;
  const ids = new Set();
  state.armoires.forEach(a => { if (a.id && inPeeeps(a)) ids.add(String(a.id)); });
  state.points.forEach(p => { if (p.idArmoire && inPeeeps(p)) ids.add(String(p.idArmoire)); });
  if (cur) ids.add(String(cur));
  const sorted = [...ids].sort();
  sel.innerHTML = '<option value="">-- Aucune --</option>' +
    sorted.map(id => `<option${String(cur) === id ? ' selected' : ''}>${escapeHtml(id)}</option>`).join('') +
    '<option value="__new">＋ Nouvel ID armoire…</option>';
  sel.value = cur || '';
  sel.onchange = function() {
    if (this.value === '__new') {
      const v = (prompt('Nouvel ID armoire :') || '').trim();
      if (v) {
        const o = document.createElement('option');
        o.textContent = v;
        this.insertBefore(o, this.lastElementChild);
        this.value = v;
      } else this.value = '';
    }
  };
}

/* ═══════════ ORDRE DES CHAMPS DANS LES FICHES ═══════════ */
// Chaque entrée pointe un élément de la fiche ; son bloc (.form-row) est déplaçable.
const PL_ORDER_DEFS = [
  { key:'nbrSupports',   label:'Nbr supports',        el:'f-nbr-supports' },
  { key:'typeSupport',   label:'Type de support',     el:'f-type-support' },
  { key:'etatSupport',   label:'État du support',     el:'f-etat-support' },
  { key:'hauteur',       label:'Hauteur',             el:'f-hauteur' },
  { key:'typeAttache',   label:"Type d'attache",      el:'f-type-attache' },
  { key:'nbrLuminaires', label:'Nbr luminaires',      el:'f-nbr-luminaires' },
  { key:'typeLuminaire', label:'Type de luminaire',   el:'f-type-luminaire' },
  { key:'etatLuminaire', label:'État luminaires',     el:'f-etat-luminaire' },
  { key:'technologie',   label:'Technologie',         el:'f-technologie' },
  { key:'puissance',     label:'Puissance',           el:'f-puissance' },
  { key:'idArmoire',     label:'ID Armoire',          el:'f-id-armoire' },
  { key:'classePrec',    label:'Classe de précision', el:'f-classe-precision' },
  { key:'photos',        label:'Photos',              q:'.photo-grid' },
  { key:'panier',        label:'Dans le panier',      el:'toggle-panier' },
  { key:'observations',  label:'Observations',        el:'f-observations' },
  { key:'custom',        label:'Champs personnalisés', el:'custom-fields-pl', self:true },
];
const ARM_ORDER_DEFS = [
  { key:'etatExt',      label:'État extérieur',       el:'af-etat-ext' },
  { key:'etatInt',      label:'État intérieur',       el:'af-etat-int' },
  { key:'abonnement',   label:'Abonnement (kVA)',     el:'af-abonnement' },
  { key:'cable',        label:"Câble d'alimentation", el:'af-cable' },
  { key:'departs',      label:'Départs',              el:'af-departs' },
  { key:'protection',   label:'Protection',           el:'af-protection' },
  { key:'horloge',      label:'Horloge',              el:'af-horloge' },
  { key:'photos',       label:'Photos',               q:'.photo-grid' },
  { key:'observations', label:'Observations',         el:'af-observations' },
  { key:'custom',       label:'Champs personnalisés', el:'custom-fields-arm', self:true },
];
// Défs complètes = champs standard (dont ceux qui manquaient) + un item par champ personnalisé
function plOrderDefs() {
  const base = PL_ORDER_DEFS.filter(d => d.key !== 'custom' && d.el !== 'custom-fields-pl').slice();
  base.push({ key:'verifie', label:'Vérifié sur le terrain', el:'toggle-verifie' });
  base.push({ key:'depose', label:'Point à déposer', el:'toggle-depose' });
  (CONFIG.customFields || []).forEach(cf =>
    base.push({ key:'cf:' + cf.key, label:cf.label + ' (perso)', el:'cf-' + cf.key }));
  return base;
}
function armOrderDefs() {
  const base = ARM_ORDER_DEFS.filter(d => d.key !== 'custom' && d.el !== 'custom-fields-arm').slice();
  (CONFIG.armCustomFields || []).forEach(cf =>
    base.push({ key:'acf:' + cf.key, label:cf.label + ' (perso)', el:'acf-' + cf.key }));
  return base;
}
function effectiveOrder(defs, saved) {
  const keys = (saved || []).filter(k => defs.some(d => d.key === k));
  defs.forEach(d => { if (!keys.includes(d.key)) keys.push(d.key); }); // nouveaux champs → à la fin
  return keys;
}
function reorderForm(formSel, defs, saved) {
  const form = document.querySelector(formSel);
  if (!form) return;
  const byKey = {};
  defs.forEach(d => {
    let node = null;
    if (d.q) node = form.querySelector(d.q);
    else if (d.el) {
      const e = form.querySelector('#' + d.el);
      node = e ? (d.self ? e : e.closest('.form-row')) : null;
    }
    if (node) byKey[d.key] = node;
  });
  const keys = effectiveOrder(defs, saved).filter(k => byKey[k]);
  if (keys.length < 2) return;
  const vus = new Set();
  const nodes = keys.map(k => byKey[k]).filter(nd => { if (vus.has(nd)) return false; vus.add(nd); return true; });
  const parent = nodes[0].parentNode;
  // point d'insertion = position actuelle du bloc géré le plus haut dans la fiche
  const earliest = nodes.reduce((a, b) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? a : b);
  const marker = document.createElement('div');
  parent.insertBefore(marker, earliest);
  nodes.forEach(nd => parent.insertBefore(nd, marker));
  parent.removeChild(marker);
}
function applyFieldOrder() {
  reorderForm('#screen-form', plOrderDefs(), CONFIG.orderPL);
  reorderForm('#screen-armoire-form', armOrderDefs(), CONFIG.orderARM);
  nettoyerTitresSections('#screen-form');
  nettoyerTitresSections('#screen-armoire-form');
}

// Après réorganisation, un titre de section peut se retrouver sans aucun champ
// en dessous (les champs ont été déplacés ailleurs) : on le masque.
function nettoyerTitresSections(formSel) {
  const form = document.querySelector(formSel + ' .form-scroll') || document.querySelector(formSel);
  if (!form) return;
  const enfants = [...form.children];
  enfants.forEach((el, i) => {
    if (!el.classList || !el.classList.contains('form-section-title')) return;
    let aDuContenu = false;
    for (let j = i + 1; j < enfants.length; j++) {
      const e = enfants[j];
      if (e.classList && e.classList.contains('form-section-title')) break;   // section suivante
      // un bloc non vide et visible = la section a du contenu
      if (e.offsetParent !== null || (e.children && e.children.length)) { aDuContenu = true; break; }
    }
    el.style.display = aDuContenu ? '' : 'none';
  });
}
// Réordonne par glisser-déposer (fonctionne à la souris et au doigt)
function initOrderDrag() {
  document.querySelectorAll('.ord-list').forEach(list => {
    if (list._dragReady) return;
    list._dragReady = true;
    let src = null;
    list.addEventListener('dragstart', e => {
      const it = e.target.closest('.ord-item'); if (!it) return;
      src = it; it.classList.add('ord-drag');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', it.dataset.idx); } catch (err) {}
    });
    list.addEventListener('dragover', e => {
      e.preventDefault();
      const it = e.target.closest('.ord-item');
      if (!it || it === src) return;
      const r = it.getBoundingClientRect();
      list.insertBefore(src, (e.clientY - r.top) < r.height / 2 ? it : it.nextSibling);
    });
    list.addEventListener('dragend', () => {
      if (src) src.classList.remove('ord-drag');
      src = null;
      appliquerOrdreDepuisListe(list);
    });
    // tactile
    let tSrc = null;
    list.addEventListener('touchstart', e => {
      const it = e.target.closest('.ord-grip') ? e.target.closest('.ord-item') : null;
      if (it) { tSrc = it; it.classList.add('ord-drag'); }
    }, { passive: true });
    list.addEventListener('touchmove', e => {
      if (!tSrc) return;
      e.preventDefault();
      const t = e.touches[0];
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const it = el && el.closest ? el.closest('.ord-item') : null;
      if (it && it !== tSrc && it.parentNode === list) {
        const r = it.getBoundingClientRect();
        list.insertBefore(tSrc, (t.clientY - r.top) < r.height / 2 ? it : it.nextSibling);
      }
    }, { passive: false });
    list.addEventListener('touchend', () => {
      if (!tSrc) return;
      tSrc.classList.remove('ord-drag'); tSrc = null;
      appliquerOrdreDepuisListe(list);
    });
  });
}
function appliquerOrdreDepuisListe(list) {
  const which = list.dataset.which;
  const defs = which === 'PL' ? plOrderDefs() : armOrderDefs();
  const prop = which === 'PL' ? 'orderPL' : 'orderARM';
  const ancien = effectiveOrder(defs, CONFIG[prop]);
  const nouveau = [...list.querySelectorAll('.ord-item')].map(it => ancien[Number(it.dataset.idx)]);
  if (nouveau.length !== ancien.length || nouveau.some(k => !k)) return;
  CONFIG[prop] = nouveau;
  saveConfig();
  renderSettings();
}
function moveField(which, idx, dir) {
  const defs = which === 'PL' ? plOrderDefs() : armOrderDefs();
  const prop = which === 'PL' ? 'orderPL' : 'orderARM';
  const keys = effectiveOrder(defs, CONFIG[prop]);
  const j = idx + dir;
  if (j < 0 || j >= keys.length) return;
  [keys[idx], keys[j]] = [keys[j], keys[idx]];
  CONFIG[prop] = keys;
  saveConfig();          // applique aussi l'ordre (via applyConfig)
  renderSettings();
}

/* ═══════════ TRAMES DE FICHE (préremplissage en un tap) ═══════════ */
// Champs capturés/appliqués par une trame (l'ID armoire, la précision, le GPS
// et les observations restent propres à chaque point).
const TPL_FIELDS = ['f-nbr-supports','f-type-support','f-etat-support','f-hauteur',
  'f-type-attache','f-nbr-luminaires','f-type-luminaire','f-etat-luminaire',
  'f-technologie','f-puissance'];

// ══════════ TRAMES DEPUIS L'ONGLET "Trames" DU SHEET (tableau lisible) ══════════
let SHEET_TEMPLATES = [];   // trames lues dans l'onglet Trames (gérées à la main dans le Sheet)

// Colonnes de l'onglet Trames → champ de fiche. Plusieurs libellés acceptés (tolérant accents/casse).
const TRAME_COL_MAP = [
  { field:'f-nbr-supports',   names:['nbr supports','nombre de supports','nb supports'] },
  { field:'f-type-support',   names:['types de support','type de support','support'] },
  { field:'f-etat-support',   names:['etat du support','état du support','etat support'] },
  { field:'f-hauteur',        names:['hauteur','hauteur (m)'] },
  { field:'f-type-attache',   names:["types d'attache","type d'attache","attache"] },
  { field:'f-nbr-luminaires', names:['nbr luminaires','nombre de luminaires','nb luminaires'] },
  { field:'f-type-luminaire', names:['types de luminaire','type de luminaire','type luminaire'] },
  { field:'f-etat-luminaire', names:['etat luminaires','état luminaires','etat du luminaire','etat luminaire'] },
  { field:'f-technologie',    names:['technologie','techno'] },
  { field:'f-puissance',      names:['puissance','puissance (w)','watt','w'] },
];
// Colonnes → champ personnalisé (custom, par nom de colonne du Sheet)
const TRAME_CUSTOM_MAP = [
  { col:'Gamme luminaire',      names:['gamme du luminaire','gamme luminaire','gamme'] },
  { col:'Marque luminaire',     names:['marque du luminaire','marque luminaire','marque'] },
  { col:'Catégorie Lampadaire', names:['categorie lampadaire','catégorie lampadaire'] },
];
function _normHead(x){ return String(x||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,''); }
// Transforme un lien Google Drive en URL d'image directe (miniature). Sinon renvoie l'URL telle quelle.
function driveImageUrl(raw){
  const v = String(raw||'').trim();
  if (!v) return '';
  const m = v.match(/\/d\/([-\w]{20,})/) || v.match(/[?&]id=([-\w]{20,})/);
  if (m) return 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w400';
  return v;
}
// Vignette d'une trame : image si dispo (avec repli 💡 si le lien ne charge pas), sinon icône.
function tplThumbHTML(t){
  if (t.thumb) {
    return '<img class="tpl-thumb" src="' + t.thumb + '" alt="" referrerpolicy="no-referrer" ' +
      'onerror="this.style.display=\'none\';var f=this.nextElementSibling;if(f)f.style.display=\'flex\'">' +
      '<div class="tpl-thumb" style="display:none">💡</div>';
  }
  return '<div class="tpl-thumb">💡</div>';
}
function _findHeaderKey(row, names){
  const idx = {}; Object.keys(row).forEach(k => { idx[_normHead(k)] = k; });
  for (const nm of names){ const k = idx[_normHead(nm)]; if (k!==undefined) return k; }
  return null;
}
// Recharge les trames depuis le stockage local (hors-ligne ou avant la 1re synchro).
async function restoreTemplatesLocal(){
  if (SHEET_TEMPLATES.length) return;
  try {
    const rec = await DB.get('meta', 'templates');
    if (rec && Array.isArray(rec.v) && rec.v.length) {
      SHEET_TEMPLATES = rec.v;
      if (typeof renderTemplatesBar === 'function') renderTemplatesBar();
      if (typeof renderCustomFields === 'function') renderCustomFields();
    }
  } catch (e) {}
}
async function loadTemplatesFromSheets(silent){
  if (!navigator.onLine) { await restoreTemplatesLocal(); return; }
  try {
    const res = await fetch(SCRIPT_URL + '?sheet=Trames');   // pas de filtre chantier : trames globales
    const data = await res.json();
    if (data.error) { if (String(data.error).indexOf('not found') >= 0) return; throw new Error(data.error); }
    const rows = data.rows || [];
    if (!rows.length) { SHEET_TEMPLATES = []; return; }
    // repère la colonne "nom de la trame" (Catégorie / Nom / Trame)
    const nameKey = _findHeaderKey(rows[0], ['categorie','catégorie','nom','trame','nom de la trame']);
    const out = [];
    rows.forEach(r => {
      const name = String(nameKey ? r[nameKey] : (r['Catégorie'] || r['Nom'] || '')).trim();
      if (!name) return;
      const values = {};
      TRAME_COL_MAP.forEach(m => {
        const k = _findHeaderKey(r, m.names);
        if (k!==null && String(r[k]).trim() !== '') values[m.field] = String(r[k]).trim();
      });
      const custom = {};
      TRAME_CUSTOM_MAP.forEach(m => {
        const k = _findHeaderKey(r, m.names);
        if (k!==null && String(r[k]).trim() !== '') custom[m.col] = String(r[k]).trim();
      });
      const photoKey = _findHeaderKey(r, ['photo','lien photo','photo url','image','lien image','url photo']);
      const photoRaw = photoKey!==null ? String(r[photoKey] || '').trim() : '';   // lien D'ORIGINE, à reécrire tel quel
      const photoUrl = photoRaw ? driveImageUrl(photoRaw) : '';
      const prev = (CONFIG.templates || []).find(t => t.name.toLowerCase() === name.toLowerCase());
      out.push({ key:'sheet_'+slugify(name), name, fromSheet:true,
                 color: prev ? prev.color : null,
                 photoUrl: photoRaw,                      // ← mémorisé : plus d'effacement à la réécriture
                 thumb: photoUrl || (prev ? prev.thumb : null),
                 values, custom });
    });
    SHEET_TEMPLATES = out;
    // Sauvegarde locale des trames → disponibles hors-ligne au prochain démarrage.
    try { await DB.put('meta', { k: 'templates', v: SHEET_TEMPLATES }); } catch (e) {}
    // Filet de sécurité : si les trames arrivent après les points, on complète les fiches
    // concernées par une « Catégorie » (uniquement leurs champs restés vides).
    let _recat = 0;
    (state.points || []).forEach(p => {
      const avant = JSON.stringify([p.typeSupport, p.hauteur, p.typeLuminaire, p.technologie, p.etatSupport]);
      applyCategorieToPoint(p);
      if (JSON.stringify([p.typeSupport, p.hauteur, p.typeLuminaire, p.technologie, p.etatSupport]) !== avant) _recat++;
    });
    if (_recat) { saveLocal(); refreshMapMarkers(); }
    renderTemplatesBar();
    if (typeof renderMasseTplBar === 'function') renderMasseTplBar();
    if (currentScreen === 'settings') renderSettings();
    if (!silent && out.length) showToast(out.length + ' trame(s) chargée(s) depuis le Sheet ✓', 'success');
  } catch (e) { console.warn('load trames:', e); }
}
// Union : trames du Sheet (tableau) + trames créées dans l'app, sans doublon de nom.
function getAllTemplates(){
  const seen = new Set(); const out = [];
  SHEET_TEMPLATES.forEach(t => { const k=t.name.toLowerCase(); if(!seen.has(k)){seen.add(k); out.push(t);} });
  (CONFIG.templates||[]).forEach(t => { const k=t.name.toLowerCase(); if(!seen.has(k)){seen.add(k); out.push(t);} });
  return out;
}

function renderTemplatesBar() {
  const bar = document.getElementById('tpl-bar');
  if (!bar) return;
  let html = getAllTemplates().map((t, i) => `
    <div class="tpl-card" style="${t.color ? 'border:2px solid ' + t.color : ''}" onclick="applyTemplate(${i})">
      ${tplThumbHTML(t)}
      <div class="tpl-name">${escapeHtml(t.name)}</div>
    </div>`).join('');
  html += `
    <div class="tpl-card tpl-add" onclick="saveFormAsTemplate()">
      <div class="tpl-thumb">＋</div>
      <div class="tpl-name">Trame depuis la fiche</div>
    </div>`;
  bar.innerHTML = html;
}
function _normVal(x){ return String(x||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,''); }
// Valeurs à colorier pour le champ de couleur courant.
// Champ à liste → ses options ; champ texte/trames → les valeurs réellement présentes sur les points.
function colorValuesFor(field){
  field = field || CONFIG.colorField;
  if (String(field).indexOf('custom:') === 0) {
    const col = field.slice(7);
    const cf = (CONFIG.customFields || []).concat(CONFIG.armCustomFields || []).find(c => c.column === col);
    if (cf && (cf.type === 'select' || cf.type === 'multi') && cf.options && cf.options.length) return cf.options.slice();
    // texte / trames / sans options → on collecte les valeurs vues
    const vues = new Set();
    (state.points || []).forEach(p => { const v = p.custom && p.custom[col]; if (v != null && String(v).trim() !== '') vues.add(String(v).trim()); });
    (state.armoires || []).forEach(a => { const v = a.custom && a.custom[col]; if (v != null && String(v).trim() !== '') vues.add(String(v).trim()); });
    return [...vues].sort((a,b)=>a.localeCompare(b,'fr'));
  }
  if ((CONFIG.lists[field] || []).length) return CONFIG.lists[field].slice();
  // champ standard sans liste → valeurs vues
  const vues = new Set();
  (state.points || []).forEach(p => { const v = p[field]; if (v != null && String(v).trim() !== '') vues.add(String(v).trim()); });
  return [...vues].sort((a,b)=>a.localeCompare(b,'fr'));
}
function setFieldValueSmart(el, v){
  if (!el) return;
  if (el.tagName === 'SELECT') {
    const want = _normVal(v);
    let match = [...el.options].find(o => _normVal(o.value || o.textContent) === want);
    if (!match && want) { match = new Option(String(v), String(v)); el.add(match); }
    el.value = match ? (match.value || match.textContent) : '';
  } else { el.value = v; }
}
function applyTemplate(i) {
  const t = getAllTemplates()[i];
  if (!t) return;
  Object.entries(t.values || {}).forEach(([id, v]) => setFieldValueSmart(document.getElementById(id), v));
  Object.entries(t.custom || {}).forEach(([col, v]) => {
    const el = document.querySelector('#custom-fields-pl [data-col="' + CSS.escape(col) + '"]');
    if (el) setFieldEl(el, v);
  });
  const fs = document.querySelector('#screen-form .form-scroll');
  if (fs) fs.style.borderTop = t.color ? ('4px solid ' + t.color) : '';
  showToast('Trame « ' + t.name + ' » appliquée', 'success');
}
function saveFormAsTemplate() {
  const name = (prompt('Nom de la trame (ex : Mât droit 8m LED) :') || '').trim();
  if (!name) return;
  const values = {};
  TPL_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.value) values[id] = el.value;
  });
  const custom = {};
  Object.entries(readCustomFields()).forEach(([col, v]) => { if (v) custom[col] = v; });
  if (!Object.keys(values).length && !Object.keys(custom).length) {
    showToast('Remplis d\u2019abord la fiche avec les valeurs de la trame', 'error');
    return;
  }
  const ex = CONFIG.templates.findIndex(t => t.name.toLowerCase() === name.toLowerCase());
  if (ex >= 0) {
    if (!confirm('La trame « ' + CONFIG.templates[ex].name + ' » existe déjà.\nLa mettre à jour avec les valeurs actuelles de la fiche ?')) return;
    CONFIG.templates[ex].values = values;
    CONFIG.templates[ex].custom = custom;
    saveConfig();
    renderTemplatesBar();
    showToast('Trame « ' + CONFIG.templates[ex].name + ' » mise à jour', 'success');
    return;
  }
  CONFIG.templates.push({ key: slugify(name) + '_' + Date.now(), name, thumb: null, color: null, values, custom });
  saveConfig();
  renderTemplatesBar();
  showToast('Trame « ' + name + ' » créée — photo et couleur dans Réglages', 'success');
}
function deleteTemplate(i) {
  const t = CONFIG.templates[i];
  if (!confirm('Supprimer la trame « ' + t.name + ' » ?')) return;
  CONFIG.templates.splice(i, 1);
  saveConfig(); renderSettings();
}
const TPL_EDIT_DEFS = [
  { id:'f-nbr-supports',   label:'Nbr supports' },
  { id:'f-type-support',   label:'Type de support',   list:'typeSupport' },
  { id:'f-etat-support',   label:'État du support',   list:'etatSupport' },
  { id:'f-hauteur',        label:'Hauteur' },
  { id:'f-type-attache',   label:"Type d'attache",    list:'typeAttache' },
  { id:'f-nbr-luminaires', label:'Nbr luminaires' },
  { id:'f-type-luminaire', label:'Type de luminaire', list:'typeLuminaire' },
  { id:'f-etat-luminaire', label:'État luminaires',   list:'etatLuminaire' },
  { id:'f-technologie',    label:'Technologie',       list:'technologie' },
  { id:'f-puissance',      label:'Puissance' },
];
function newTemplateFromSettings() {
  const name = (prompt('Nom de la nouvelle trame :') || '').trim();
  if (!name) return;
  if (CONFIG.templates.some(t => t.name.toLowerCase() === name.toLowerCase())) {
    showToast('Une trame porte déjà ce nom', 'error');
    return;
  }
  CONFIG.templates.push({ key: slugify(name) + '_' + Date.now(), name, thumb: null, color: null, values: {}, custom: {} });
  window._editTpl = CONFIG.templates.length - 1;   // ouvre directement l'éditeur
  _openSections.add('Trames de fiche (point lumineux)');
  saveConfig();
  renderSettings();
}
function editTemplate(i) {
  window._editTpl = (window._editTpl === i) ? null : i;
  _openSections.add('Trames de fiche (point lumineux)');
  renderSettings();
}
function renderTemplateEditor(t, i) {
  let h = `<div class="set-card" style="border-color:var(--accent)">
    <div class="set-card-title">Modifier « ${escapeHtml(t.name)} »</div>
    <div class="form-label" style="margin-top:6px">Nom</div>
    <input class="set-input" id="tpe-name" value="${escapeHtml(t.name)}" style="margin-bottom:8px">`;
  TPL_EDIT_DEFS.forEach(d => {
    const cur = (t.values || {})[d.id] || '';
    h += `<div class="form-label" style="margin-top:6px">${escapeHtml(d.label)}</div>`;
    if (d.list) {
      const opts = ['<option value="">--</option>'].concat((CONFIG.lists[d.list] || []).map(o =>
        `<option${o === cur ? ' selected' : ''}>${escapeHtml(o)}</option>`));
      if (cur && !(CONFIG.lists[d.list] || []).includes(cur)) opts.push(`<option selected>${escapeHtml(cur)}</option>`);
      h += `<select class="set-input" id="tpe-${d.id}" style="margin-bottom:6px">${opts.join('')}</select>`;
    } else {
      h += `<input class="set-input" id="tpe-${d.id}" value="${escapeHtml(cur)}" style="margin-bottom:6px">`;
    }
  });
  (CONFIG.customFields || []).forEach(cf => {
    const cur = (t.custom || {})[cf.column] || '';
    h += `<div class="form-label" style="margin-top:6px">${escapeHtml(cf.label)}</div>`;
    if (cf.type === 'select') {
      const opts = ['<option value="">--</option>'].concat((cf.options || []).map(o =>
        `<option${o === cur ? ' selected' : ''}>${escapeHtml(o)}</option>`));
      h += `<select class="set-input" id="tpec-${cf.key}" data-col="${escapeHtml(cf.column)}" style="margin-bottom:6px">${opts.join('')}</select>`;
    } else {
      const ph = cf.type === 'multi' ? 'valeurs séparées par des virgules' : '';
      h += `<input class="set-input" id="tpec-${cf.key}" data-col="${escapeHtml(cf.column)}" value="${escapeHtml(cur)}" placeholder="${ph}" style="margin-bottom:6px">`;
    }
  });
  h += `<div class="set-add" style="margin-top:10px">
    <button class="set-btn" onclick="saveTemplateEdit(${i})">Enregistrer la trame</button>
    <button class="set-mini" style="width:auto;padding:0 12px" onclick="window._editTpl=null;renderSettings()">Annuler</button>
  </div></div>`;
  return h;
}
function saveTemplateEdit(i) {
  const t = CONFIG.templates[i];
  const name = (document.getElementById('tpe-name').value || '').trim();
  if (name) t.name = name;
  const values = {};
  TPL_EDIT_DEFS.forEach(d => {
    const el = document.getElementById('tpe-' + d.id);
    if (el && el.value) values[d.id] = el.value;
  });
  const custom = {};
  (CONFIG.customFields || []).forEach(cf => {
    const el = document.getElementById('tpec-' + cf.key);
    if (el && el.value) custom[cf.column] = el.value;
  });
  t.values = values;
  t.custom = custom;
  window._editTpl = null;
  saveConfig(); renderSettings(); renderTemplatesBar();
  showToast('Trame « ' + t.name + ' » enregistrée', 'success');
}
// Champs éditables d'une trame du tableau
const SHEET_TPL_FIELDS = [
  ['f-type-support','Type de support','typeSupport'],
  ['f-etat-support','État du support','etatSupport'],
  ['f-hauteur','Hauteur','hauteur'],
  ['f-type-attache',"Type d'attache",'typeAttache'],
  ['f-nbr-luminaires','Nbr luminaires',null],
  ['f-type-luminaire','Type de luminaire','typeLuminaire'],
  ['f-etat-luminaire','État luminaires','etatLuminaire'],
  ['f-technologie','Technologie','technologie'],
  ['f-puissance','Puissance',null],
];
function editSheetTemplate(si){
  window._editSheetTpl = (window._editSheetTpl === si) ? null : si;
  _openSections.add('Trames de fiche (point lumineux)');
  renderSettings();
}
function renderSheetTemplateEditor(t, si){
  let h = '<div class="set-card" style="border-color:var(--accent)">';
  h += '<div class="set-card-title">Modifier « ' + escapeHtml(t.name) + ' »</div>';
  h += '<div class="form-label" style="margin-top:6px">Nom</div><input class="set-input" id="stpe-name" value="' + escapeHtml(t.name) + '" style="margin-bottom:8px">';
  SHEET_TPL_FIELDS.forEach(([fid,label,listKey]) => {
    const cur = (t.values||{})[fid] || '';
    h += '<div class="form-label" style="margin-top:6px">' + escapeHtml(label) + '</div>';
    if (listKey && CONFIG.lists[listKey]) {
      const opts = ['<option value="">--</option>'].concat(CONFIG.lists[listKey].map(o => '<option' + (o===cur?' selected':'') + '>' + escapeHtml(o) + '</option>'));
      if (cur && !CONFIG.lists[listKey].includes(cur)) opts.push('<option selected>' + escapeHtml(cur) + '</option>');
      h += '<select class="set-input" id="stpe-' + fid + '" style="margin-bottom:6px">' + opts.join('') + '</select>';
    } else {
      h += '<input class="set-input" id="stpe-' + fid + '" value="' + escapeHtml(cur) + '" style="margin-bottom:6px">';
    }
  });
  // champs perso (Gamme, Marque…)
  (CONFIG.customFields||[]).forEach(cf => {
    const cur = (t.custom||{})[cf.column] || '';
    h += '<div class="form-label" style="margin-top:6px">' + escapeHtml(cf.label) + '</div>';
    h += '<input class="set-input" id="stpec-' + cf.key + '" data-col="' + escapeHtml(cf.column) + '" value="' + escapeHtml(cur) + '" style="margin-bottom:6px">';
  });
  h += '<div class="set-add" style="margin-top:10px">';
  h += '<button class="set-btn" onclick="saveSheetTemplateEdit(' + si + ')" style="background:#4ade80;color:#04222e">Enregistrer dans le Sheet</button>';
  h += '<button class="set-mini" style="width:auto;padding:0 12px" onclick="window._editSheetTpl=null;renderSettings()">Annuler</button>';
  h += '<button class="set-mini" style="width:auto;padding:0 12px;color:#f87171;border-color:#f87171" onclick="deleteSheetTemplate(' + si + ')">Supprimer</button>';
  h += '</div></div>';
  return h;
}
async function saveSheetTemplateEdit(si){
  const t = SHEET_TEMPLATES[si]; if (!t) return;
  const name = (document.getElementById('stpe-name').value||'').trim();
  if (name) t.name = name;
  const values = {};
  SHEET_TPL_FIELDS.forEach(([fid]) => { const el = document.getElementById('stpe-'+fid); if (el && el.value) values[fid] = el.value; });
  const custom = {};
  (CONFIG.customFields||[]).forEach(cf => { const el = document.getElementById('stpec-'+cf.key); if (el && el.value) custom[cf.column] = el.value; });
  t.values = values; t.custom = custom;
  window._editSheetTpl = null;
  await pushSheetTemplates();
  renderSettings(); renderTemplatesBar();
  showToast('Trame « ' + t.name + ' » enregistrée dans le Sheet', 'success');
}
async function deleteSheetTemplate(si){
  const t = SHEET_TEMPLATES[si]; if (!t) return;
  if (!confirm('Supprimer la trame « ' + t.name + ' » du tableau ?')) return;
  SHEET_TEMPLATES.splice(si, 1);
  window._editSheetTpl = null;
  await pushSheetTemplates();
  renderSettings(); renderTemplatesBar();
  showToast('Trame supprimée', '');
}
// Réécrit tout l'onglet Trames depuis SHEET_TEMPLATES
async function pushSheetTemplates(){
  if (!navigator.onLine) { showToast('Hors ligne — modification enregistrée au retour du réseau', 'error'); return; }
  if (!SHEET_TEMPLATES.length) { showToast('Aucune trame à écrire — opération annulée par sécurité', 'error'); return; }  // anti-effacement
  const headers = ['Catégorie','Nbr supports','Types de support','État du support','Hauteur',
    "Types d'attache",'Nbr Luminaires','Types de luminaire','État luminaires','Technologie','Puissance',
    'Gamme du luminaire','Marque du luminaire','Photo'];
  const F = { supNbr:'f-nbr-supports', supType:'f-type-support', supEtat:'f-etat-support', haut:'f-hauteur',
    att:'f-type-attache', lumNbr:'f-nbr-luminaires', lumType:'f-type-luminaire', lumEtat:'f-etat-luminaire',
    tech:'f-technologie', puis:'f-puissance' };
  const rows = SHEET_TEMPLATES.map(t => {
    const v = t.values||{}, c = t.custom||{};
    return [ t.name, v[F.supNbr]||'', v[F.supType]||'', v[F.supEtat]||'', v[F.haut]||'',
      v[F.att]||'', v[F.lumNbr]||'', v[F.lumType]||'', v[F.lumEtat]||'', v[F.tech]||'', v[F.puis]||'',
      c['Gamme luminaire']||'', c['Marque luminaire']||'', t.photoUrl||'' ];
  });
  try {
    const res = await fetch(SCRIPT_URL, { method:'POST', headers:{'Content-Type':'text/plain'},
      body: JSON.stringify({ action:'saveTrames', headers, rows }) });
    const r = await res.json();
    if (r.error) throw new Error(r.error);
  } catch (e) { showToast('Échec écriture Trames : ' + e.message, 'error'); }
}
// Photo d'une trame du tableau : upload Drive → dossier "Photos de trame" → lien dans la colonne Photo
async function sheetTplPhoto(si, input){
  const file = input.files && input.files[0];
  if (!file) return;
  const t = SHEET_TEMPLATES[si]; if (!t) return;
  showToast('Envoi de la photo…', '');
  try {
    const blob = await downscaleToBlob(file);
    const b64 = await blobToBase64(blob);
    const res = await fetch(SCRIPT_URL, { method:'POST', headers:{'Content-Type':'text/plain'},
      body: JSON.stringify({ action:'tramePhoto', name:t.name, chantier: state.chantier || '', data:b64, mime:'image/jpeg' }) });
    const r = await res.json();
    if (r.error) throw new Error(r.error);
    t.photoUrl = r.url;
    t.thumb = driveImageUrl(r.url);
    renderSettings(); renderTemplatesBar();
    // le serveur inscrit lui-même le lien dans la cellule Photo (v3.9) ; on remonte le diagnostic.
    if (r.ecritDansSheet === false) {
      showToast('Photo dans Drive ✓ mais lien NON écrit : ' + (r.info || 'vérifier le mode Tableau du Sheet'), 'error');
    } else {
      showToast('Photo enregistrée + lien écrit dans le Sheet ✓', 'success');
    }
  } catch (e) { showToast('Échec photo trame : ' + e.message, 'error'); }
}
function sheetTplColor(name, color){
  const t = SHEET_TEMPLATES.find(x => x.name === name);
  if (t) t.color = color;
  // mémorise la couleur via une entrée légère dans CONFIG.templates (sans valeurs) pour persister
  let c = (CONFIG.templates||[]).find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!c) { c = { key:'clr_'+slugify(name), name, color, thumb:null, values:{}, custom:{}, colorOnly:true }; CONFIG.templates.push(c); }
  else c.color = color;
  saveConfig(); renderTemplatesBar(); renderSettings();
}
function tplColorChanged(i, color) {
  CONFIG.templates[i].color = color;
  saveConfig(); renderSettings(); renderTemplatesBar();
}
function renameTemplate(i) {
  const v = (prompt('Nouveau nom de la trame :', CONFIG.templates[i].name) || '').trim();
  if (!v) return;
  CONFIG.templates[i].name = v;
  saveConfig(); renderSettings(); renderTemplatesBar();
}
function tplPhotoChanged(i, input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    const scale = Math.min(1, 160 / img.width);
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    CONFIG.templates[i].thumb = c.toDataURL('image/jpeg', 0.7);
    URL.revokeObjectURL(img.src);
    saveConfig(); renderSettings();
    showToast('Photo de trame mise à jour', 'success');
  };
  img.src = URL.createObjectURL(file);
}

/* ═══════════ IMPORT DE POINTS (SIG → carte) ═══════════ */
function _projDef(crs) {
  if (crs === 'l93') return '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
  const m = /^cc(4[2-9]|50)$/.exec(crs);
  if (m) {
    const z = parseInt(m[1], 10);
    return '+proj=lcc +lat_0=' + z + ' +lon_0=3 +lat_1=' + (z - 0.75) + ' +lat_2=' + (z + 0.75) +
      ' +x_0=1700000 +y_0=' + ((z - 42) * 1000000 + 1200000) + ' +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
  }
  return null;
}
function _detectCRS(x, y) {
  if (Math.abs(x) <= 180 && Math.abs(y) <= 90) {
    // GPS — reste à deviner l'ordre lon/lat
    const isLat = v => (v >= 41 && v <= 51.5) || (v >= 13.5 && v <= 18.5);   // métropole / Antilles
    const isLon = v => (v >= -6 && v <= 10) || (v >= -63 && v <= -60);
    if (isLon(x) && isLat(y)) return 'wgs';
    if (isLat(x) && isLon(y)) return 'wgs_latlon';
    return 'wgs';
  }
  if (x >= 1300000 && y >= 1000000 && y <= 8400000) {
    const z = 42 + Math.round((y - 1200000) / 1000000);
    if (z >= 42 && z <= 50) return 'cc' + z;
  }
  if (y >= 6000000 && y <= 7300000) return 'l93';
  return null;
}
function _parseImportText() {
  const raw = (document.getElementById('imp-text').value || '').trim();
  if (!raw) return { rows: [], errors: ['Aucune donnée collée'] };
  const rows = [];
  const errors = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    const parts = t.split(/[;,\t]+/).map(v => v.trim()).filter(v => v !== '');
    if (parts.length < 3) { if (i > 0 || rows.length) errors.push('Ligne ' + (i + 1) + ' incomplète'); return; }
    const x = parseFloat(String(parts[1]).replace(',', '.'));
    const y = parseFloat(String(parts[2]).replace(',', '.'));
    if (!isFinite(x) || !isFinite(y)) {
      if (i === 0) return;                       // ligne d'en-tête probable → ignorée
      errors.push('Ligne ' + (i + 1) + ' : coordonnées illisibles');
      return;
    }
    rows.push({ id: String(parts[0]), x, y });
  });
  return { rows, errors };
}
let _impReady = null;
function previewImport() {
  const out = document.getElementById('imp-preview');
  const go = document.getElementById('imp-go');
  _impReady = null;
  go.style.display = 'none';
  const { rows, errors } = _parseImportText();
  if (!rows.length) { out.textContent = errors[0] || 'Aucun point détecté'; return; }
  let crs = document.getElementById('imp-crs').value;
  if (crs === 'auto') {
    crs = _detectCRS(rows[0].x, rows[0].y);
    if (!crs) { out.textContent = 'Système de coordonnées non reconnu — choisissez-le manuellement dans la liste.'; return; }
  }
  const def = _projDef(crs);
  if (def && typeof proj4 === 'undefined') {
    out.textContent = 'Module de conversion non chargé — connectez-vous à internet, rechargez l\u2019app, puis réessayez.';
    return;
  }
  const pts = [];
  for (const r of rows) {
    let lat, lng;
    if (crs === 'wgs') { lng = r.x; lat = r.y; }
    else if (crs === 'wgs_latlon') { lat = r.x; lng = r.y; }
    else { const c = proj4(def, proj4.WGS84, [r.x, r.y]); lng = c[0]; lat = c[1]; }
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    pts.push({ id: r.id, lat: +lat.toFixed(7), lng: +lng.toFixed(7) });
  }
  if (!pts.length) { out.textContent = 'Conversion impossible — vérifiez le système choisi.'; return; }
  const existing = new Set(state.points.map(p => String(p.id)));
  const news = pts.filter(p => !existing.has(String(p.id)));
  const labels = { wgs: 'GPS (lon;lat)', wgs_latlon: 'GPS (lat;lon)', l93: 'Lambert-93' };
  const crsLabel = labels[crs] || crs.toUpperCase();
  out.innerHTML = '<b>' + pts.length + '</b> point(s) lus · système <b>' + crsLabel + '</b> · 1er point → ' +
    pts[0].lat.toFixed(5) + ', ' + pts[0].lng.toFixed(5) +
    (pts.length - news.length ? ' · <span style="color:#facc15">' + (pts.length - news.length) + ' déjà existants (ignorés)</span>' : '') +
    (errors.length ? ' · <span style="color:#f87171">' + errors.length + ' ligne(s) ignorée(s)</span>' : '') +
    (news.length > 800 ? '<br><span style="color:#facc15">Import volumineux : préférez le collage direct dans le Sheet (voir MODOP).</span>' : '');
  if (news.length) {
    _impReady = news;
    go.style.display = '';
    go.textContent = 'Importer ' + news.length + ' point(s)';
  } else {
    out.innerHTML += '<br>Rien de nouveau à importer.';
  }
}
async function runImport() {
  const news = _impReady;
  if (!news || !news.length) { showToast('Faites d\u2019abord « Analyser »', 'error'); return; }
  _impReady = null;
  document.getElementById('imp-go').style.display = 'none';
  const today = new Date().toISOString().split('T')[0];
  const created = [];
  for (const p of news) {
    const pt = {
      id: p.id,
      idArmoire: p.id.indexOf('-') > 0 ? p.id.split('-')[0] : '',
      lat: p.lat, lng: p.lng,
      nbrSupports: '', typeSupport: '', etatSupport: '', hauteur: '', typeAttache: '',
      nbrLuminaires: '', typeLuminaire: '', etatLuminaire: '', technologie: '', puissance: '',
      observations: '', custom: {}, photos: {},
      dansPanier: false,
      chantier: state.chantier,
      technicien: state.technicien,
      date: today,
      classePrecision: 'C',
      sourcePosition: 'Import SIG (app)',
      gpsAccuracy: null
    };
    state.points.push(pt);
    created.push(pt);
    try { await DB.put('queue', { id: pt.id, pt: pt, ts: Date.now() }); } catch (e) {}
  }
  saveLocal();
  refreshMapMarkers();
  updateStatus();
  showToast(created.length + ' point(s) importé(s) — synchronisation en cours…', 'success');
  document.getElementById('imp-text').value = '';
  document.getElementById('imp-preview').textContent = '—';
  // Zoom sur la zone importée
  const latlngs = created.map(p => [p.lat, p.lng]);
  if (latlngs.length === 1) { showScreen('map'); map.setView(latlngs[0], 18); }
  else if (latlngs.length > 1) { showScreen('map'); map.fitBounds(latlngs, { padding: [40, 40], maxZoom: 18 }); }
  flushSyncQueue();
}

/* ═══════════ PAGE RÉGLAGES : rendu + édition ═══════════ */
let _openSections = new Set();
function toggleSection(el) {
  const t = el.dataset.t;
  if (_openSections.has(t)) _openSections.delete(t); else _openSections.add(t);
  renderSettings();
}
function renderSettings() {
  const _offline_section = `
    <div class="set-section-title">🛰️ Mode hors-ligne — préparation terrain</div>
    <div class="set-card">
      <div class="set-empty" style="margin-bottom:10px">Vérifiez que tout est prêt <b>avant</b> de partir en zone sans réseau. Faites-le en wifi.</div>
      <div id="offline-check"></div>
      <div class="set-add" style="margin-top:10px;flex-wrap:wrap;gap:6px">
        <button class="set-btn" onclick="checkOfflineReady()">🔄 Vérifier</button>
        <button class="set-btn" style="background:var(--accent);color:#04121f;font-weight:700" onclick="prepareOfflineAll()">⬇️ Tout préparer pour le terrain</button>
      </div>
    </div>`;

  setTimeout(() => { try { refreshTilesInfo(); } catch(e){} }, 60);
  const box = document.getElementById('settings-body');
  if (!box) return;
  let html = _offline_section + '<div class="set-section-title">Listes de choix</div>';
  LIST_FIELDS.forEach(f => {
    const chips = (CONFIG.lists[f.key] || []).map((o, i) =>
      `<span class="set-chip">${escapeHtml(o)}<span class="set-chip-x" onclick="removeOption('${f.key}',${i})">×</span></span>`
    ).join('');
    html += `<div class="set-card">
      <div class="set-card-title">${escapeHtml(f.label)}</div>
      <div class="set-chips">${chips || '<span class="set-empty">Aucune option</span>'}</div>
      <div class="set-add">
        <input class="set-input" id="addopt-${f.key}" placeholder="Nouvelle option…">
        <button class="set-btn" onclick="addOption('${f.key}')">Ajouter</button>
      </div>
    </div>`;
  });

  html += '<div class="set-section-title">Champs personnalisés (nouvelles colonnes)</div>';
  if (!CONFIG.customFields.length) html += '<div class="set-empty" style="padding:0 4px 8px">Aucun champ personnalisé pour le moment.</div>';
  CONFIG.customFields.forEach((cf, i) => {
    const typeLabel = cf.type === 'select' ? 'Liste de choix'
      : (cf.type === 'multi' ? 'Choix multiples'
      : (cf.type === 'trames' ? 'Liste des trames (auto)' : 'Texte libre'));
    let optChips = '';
    if (cf.type === 'trames') {
      optChips = '<div class="set-empty">Les choix sont les noms de vos trames — mis à jour automatiquement.</div>';
    } else if (cf.type === 'select' || cf.type === 'multi') {
      optChips = '<div class="set-chips">' + (cf.options || []).map((o, oi) =>
        `<span class="set-chip">${escapeHtml(o)}<span class="set-chip-x" onclick="removeCustomOption(${i},${oi})">×</span></span>`
      ).join('') + '</div><div class="set-add"><input class="set-input" id="addcfopt-' + i + '" placeholder="Nouvelle option…"><button class="set-btn" onclick="addCustomOption(' + i + ')">Ajouter</button></div>';
    }
    html += `<div class="set-card">
      <div class="set-card-title">${escapeHtml(cf.label)} <span class="set-tag">→ colonne « ${escapeHtml(cf.column)} » · ${typeLabel}</span></div>
      ${optChips}
      <div class="set-add">
        <select class="set-input" style="max-width:190px" onchange="changeCustomFieldType(${i}, this.value)">
          <option value="text"${cf.type === 'text' ? ' selected' : ''}>Texte libre</option>
          <option value="select"${cf.type === 'select' ? ' selected' : ''}>Liste de choix</option>
          <option value="multi"${cf.type === 'multi' ? ' selected' : ''}>Choix multiples</option>
          <option value="trames"${cf.type === 'trames' ? ' selected' : ''}>Liste des trames (auto)</option>
        </select>
        <button class="set-btn" onclick="renameCustomField(${i})">✏️ Renommer</button>
        <button class="set-btn set-btn-del" onclick="removeCustomField(${i})">Supprimer</button>
      </div>
    </div>`;
  });
  html += `<div class="set-card">
    <div class="set-card-title">+ Ajouter un champ</div>
    <input class="set-input" id="cf-new-label" placeholder="Nom du champ (ex : Marque du luminaire)" style="margin-bottom:8px">
    <select class="set-input" id="cf-new-type" onchange="document.getElementById('cf-new-optrow').style.display=(this.value==='select'||this.value==='multi')?'flex':'none'" style="margin-bottom:8px">
      <option value="text">Texte libre</option>
      <option value="select">Liste de choix</option>
      <option value="multi">Liste à choix multiples</option>
    </select>
    <div class="set-add" id="cf-new-optrow" style="display:none;margin-bottom:8px">
      <input class="set-input" id="cf-new-options" placeholder="Options séparées par des virgules">
    </div>
    <button class="set-btn" onclick="addCustomField()">Créer le champ</button>
  </div>`;

  html += '<div class="set-section-title">Trames de fiche (point lumineux)</div>';
  if (SHEET_TEMPLATES.length) {
    html += '<div class="set-card">';
    html += '<div class="set-empty" style="margin-bottom:8px">' + SHEET_TEMPLATES.length + ' trame(s) gérée(s) dans l\u2019onglet <b>Trames</b> du Sheet (ajout/suppression directement dans le tableau) :</div>';
    SHEET_TEMPLATES.forEach((t, si) => {
      const nb = Object.keys(t.values||{}).length + Object.keys(t.custom||{}).length;
      html += `<div class="set-tpl-row">
        ${t.thumb ? `<img class="set-tpl-thumb" src="${t.thumb}" alt="">` : `<div class="set-tpl-thumb">📄</div>`}
        <div style="flex:1;min-width:0"><div class="set-color-label" style="font-weight:600">${escapeHtml(t.name)}</div>
        <div class="set-empty">${nb} caractéristique(s) · depuis le Sheet</div></div>
        <input type="color" class="set-color" style="width:34px;height:30px" value="${t.color || '#e2e8f0'}" onchange="sheetTplColor('${escapeHtml(t.name)}', this.value)" title="Couleur de l'encadré">
        <label class="set-mini" style="display:flex;align-items:center;justify-content:center;cursor:pointer" title="Photo (rangée dans Drive)">📷
          <input type="file" accept="image/*" style="display:none" onchange="sheetTplPhoto(${si}, this)">
        </label>
        <button class="set-mini" onclick="editSheetTemplate(${si})" title="Modifier">✏️</button>
      </div>`;
      if (window._editSheetTpl === si) html += renderSheetTemplateEditor(t, si);
    });
    html += '</div>';
  }
  html += '<div class="set-section-title" style="font-size:13px;opacity:.8">Trames créées dans l\u2019app</div>';
  html += '<div class="set-card">';
  if (!(CONFIG.templates || []).length) {
    html += '<div class="set-empty">Aucune trame. Dans une fiche point, remplis les champs types puis touche « ＋ Trame depuis la fiche ».</div>';
  } else {
    CONFIG.templates.forEach((t, i) => {
      const nb = Object.keys(t.values || {}).length + Object.keys(t.custom || {}).length;
      html += `<div class="set-tpl-row">
        ${t.thumb ? `<img class="set-tpl-thumb" src="${t.thumb}" alt="">` : `<div class="set-tpl-thumb">💡</div>`}
        <div style="flex:1;min-width:0">
          <div class="set-color-label" style="font-weight:600">${escapeHtml(t.name)}</div>
          <div class="set-empty">${nb} caractéristique${nb > 1 ? 's' : ''}</div>
        </div>
        <input type="color" class="set-color" style="width:34px;height:30px" value="${t.color || '#e2e8f0'}" onchange="tplColorChanged(${i}, this.value)" title="Couleur de l'encadré">
        <label class="set-mini" style="display:flex;align-items:center;justify-content:center;cursor:pointer">📷
          <input type="file" accept="image/*" style="display:none" onchange="tplPhotoChanged(${i}, this)">
        </label>
        <button class="set-mini" onclick="editTemplate(${i})">✏️</button>
        <button class="set-mini" style="color:#f87171;border-color:#f87171" onclick="deleteTemplate(${i})">🗑</button>
      </div>`;
      if (window._editTpl === i) html += renderTemplateEditor(t, i);
    });
  }
  html += '<div class="set-add" style="margin-top:10px"><button class="set-btn" onclick="newTemplateFromSettings()">＋ Nouvelle trame</button></div>';
  html += '</div>';

  html += '<div class="set-section-title">Cartes hors-ligne</div>';
  html += `<div class="set-card">
    <div class="set-empty" style="margin-bottom:8px">Cartes téléchargées pour une utilisation sans réseau. Le préchargement se fait depuis la carte (bouton de téléchargement), selon le fond affiché.</div>
    <div class="set-color-row"><span class="set-color-label">Tuiles en cache</span><span id="set-tiles-count" style="font-weight:600">—</span></div>
    <div class="set-color-row"><span class="set-color-label">Espace estimé</span><span id="set-tiles-size" style="font-weight:600">—</span></div>
    <div class="set-add" style="margin-top:8px">
      <button class="set-btn" onclick="refreshTilesInfo()">Actualiser</button>
      <button class="set-btn set-btn-del" onclick="clearTileCache().then(refreshTilesInfo)">Vider les cartes</button>
    </div>
  </div>`;

  html += '<div class="set-section-title">Importer des points (PEEEPS : ' + escapeHtml(state.chantier || '?') + ')</div>';
  html += `<div class="set-card">
    <div class="set-empty" style="margin-bottom:8px">Collez les points du SIG : une ligne par point, <b>ID ; X ; Y</b> (séparateur ; , ou tabulation). Les coordonnées Lambert-93 et Coniques Conformes (CC42-CC50) sont converties automatiquement en GPS.</div>
    <textarea class="set-input" id="imp-text" rows="6" placeholder="0100-0115;1500893.9;3222888.3&#10;0100-0116;1500901.2;3222901.7&#10;…" style="font-family:monospace;font-size:12px;margin-bottom:8px"></textarea>
    <div class="set-add" style="margin-bottom:8px">
      <select class="set-input" id="imp-crs">
        <option value="auto">Système : détection automatique</option>
        <option value="wgs">GPS (longitude;latitude)</option>
        <option value="wgs_latlon">GPS (latitude;longitude)</option>
        <option value="l93">Lambert-93</option>
        <option value="cc42">CC42</option><option value="cc43">CC43</option><option value="cc44">CC44</option>
        <option value="cc45">CC45</option><option value="cc46">CC46</option><option value="cc47">CC47</option>
        <option value="cc48">CC48</option><option value="cc49">CC49</option><option value="cc50">CC50</option>
      </select>
    </div>
    <div class="set-empty" id="imp-preview" style="margin-bottom:8px">—</div>
    <div class="set-add">
      <button class="set-btn" onclick="previewImport()">Analyser</button>
      <button class="set-btn" id="imp-go" onclick="runImport()" style="display:none;background:#4ade80;color:#04222e">Importer</button>
    </div>
  </div>`;

  html += '<div class="set-section-title">Ordre des champs dans les fiches</div>';
  [['PL', 'Fiche point lumineux', plOrderDefs(), CONFIG.orderPL], ['ARM', 'Fiche armoire', armOrderDefs(), CONFIG.orderARM]].forEach(([which, title, defs, saved]) => {
    const keys = effectiveOrder(defs, saved);
    html += `<div class="set-card"><div class="set-card-title">${title}</div>
      <div class="set-empty" style="margin-bottom:6px">Glissez un champ pour le déplacer (les flèches restent disponibles).</div>
      <div class="ord-list" data-which="${which}">`;
    keys.forEach((k, i) => {
      const d = defs.find(x => x.key === k);
      html += `<div class="set-order-row ord-item" draggable="true" data-which="${which}" data-idx="${i}">
        <span class="ord-grip">⠿</span>
        <span class="set-color-label" style="flex:1">${escapeHtml(d.label)}</span><span>
        <button class="set-mini" onclick="moveField('${which}',${i},-1)" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="set-mini" onclick="moveField('${which}',${i},1)" ${i === keys.length - 1 ? 'disabled' : ''}>▼</button>
      </span></div>`;
    });
    html += '</div></div>';
  });

  html += '<div class="set-section-title">Couleurs des points sur la carte</div>';
  html += '<div class="set-card">';
  // Champs disponibles pour déclencher la couleur : toutes les listes + champs perso de type liste
  const colorChoices = LIST_FIELDS.slice();
  // + toutes les autres listes de choix définies dans les réglages
  Object.keys(CONFIG.lists || {}).forEach(k => {
    if (!colorChoices.some(f => f.key === k) && (CONFIG.lists[k] || []).length)
      colorChoices.push({ key: k, label: k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()) });
  });
  // + TOUS les champs personnalisés des points (quel que soit leur type : texte, liste, multi, trames)
  (CONFIG.customFields || []).forEach(cf => {
    if (!colorChoices.some(f => f.key === 'custom:' + cf.column))
      colorChoices.push({ key: 'custom:' + cf.column, label: cf.label, custom: true, column: cf.column });
  });
  // + les champs personnalisés d'ARMOIRE (utile si tu colores selon une caractéristique d'armoire)
  (CONFIG.armCustomFields || []).forEach(cf => {
    if (!colorChoices.some(f => f.key === 'custom:' + cf.column))
      colorChoices.push({ key: 'custom:' + cf.column, label: cf.label + ' (armoire)', custom: true, column: cf.column });
  });
  window._colorChoices = colorChoices;
  html += '<div class="set-color-row"><span class="set-color-label">Couleur déclenchée par</span>' +
    '<select class="set-input" style="width:auto;flex:1;margin-left:8px" onchange="setColorField(this.value)">' +
    colorChoices.map(f => `<option value="${f.key}"${CONFIG.colorField === f.key ? ' selected' : ''}>${escapeHtml(f.label)}</option>`).join('') +
    '</select></div>';
  const colorFieldDef = colorChoices.find(f => f.key === CONFIG.colorField) || colorChoices[0];
  html += `<div class="set-empty" style="margin:6px 0 10px">Selon « ${escapeHtml(colorFieldDef.label)} » de chaque point — intérieur et contour réglables séparément.</div>`;
  let _colorVals = colorValuesFor(CONFIG.colorField);
  if (!_colorVals.length) html += '<div class="set-empty">Aucune valeur à colorer pour ce champ (renseignez-en dans des fiches, puis rouvrez).</div>';
  _colorVals.forEach((val, i) => {
    const c = (CONFIG.colors && CONFIG.colors[val]) || (CONFIG.colors && CONFIG.colors._default) || { fill: '#e2e8f0', border: '#ffffff' };
    html += `<div class="set-color-row">
      <span class="set-color-label">${escapeHtml(val)}</span>
      <span class="set-color-pair">
        <input type="color" class="set-color" value="${c.fill}" title="Couleur intérieure" onchange="setStateColorByIndex(${i}, this.value, 'fill')">
        <input type="color" class="set-color" value="${c.border}" title="Couleur du contour" onchange="setStateColorByIndex(${i}, this.value, 'border')">
      </span>
    </div>`;
  });
  const cdef = (CONFIG.colors && CONFIG.colors._default) || { fill: '#e2e8f0', border: '#ffffff' };
  html += `<div class="set-color-row">
    <span class="set-color-label">Autre / non renseigné</span>
    <span class="set-color-pair">
      <input type="color" class="set-color" value="${cdef.fill}" title="Couleur intérieure" onchange="setStateColor('_default', this.value, 'fill')">
      <input type="color" class="set-color" value="${cdef.border}" title="Couleur du contour" onchange="setStateColor('_default', this.value, 'border')">
    </span>
  </div>`;
  html += '<div class="set-empty" style="margin-top:8px">🎨 gauche = intérieur du point · droite = contour</div>';
  html += '</div>';

  html += '<div class="set-section-title">Armoires — listes de choix</div>';
  ARM_LIST_FIELDS.forEach(f => {
    const chips = (CONFIG.lists[f.key] || []).map((o, i) =>
      `<span class="set-chip">${escapeHtml(o)}<span class="set-chip-x" onclick="removeOption('${f.key}',${i})">×</span></span>`
    ).join('');
    html += `<div class="set-card">
      <div class="set-card-title">${escapeHtml(f.label)}</div>
      <div class="set-chips">${chips || '<span class="set-empty">Aucune option</span>'}</div>
      <div class="set-add">
        <input class="set-input" id="addopt-${f.key}" placeholder="Nouvelle option…">
        <button class="set-btn" onclick="addOption('${f.key}')">Ajouter</button>
      </div>
    </div>`;
  });
  html += '<div class="set-section-title">Armoires — champs personnalisés</div>';
  if (!CONFIG.armCustomFields.length) html += '<div class="set-empty" style="padding:0 4px 8px">Aucun champ personnalisé d’armoire.</div>';
  CONFIG.armCustomFields.forEach((cf, i) => {
    const meta = cf.type === 'select' ? ('liste : ' + (cf.options || []).join(', ')) : (cf.type === 'multi' ? ('choix multiples : ' + (cf.options || []).join(', ')) : 'texte libre');
    html += `<div class="set-card">
      <div class="set-card-title">${escapeHtml(cf.label)} <span class="set-tag">→ colonne « ${escapeHtml(cf.column)} » (Armoires)</span></div>
      <div class="set-empty">${escapeHtml(meta)}</div>
      <div class="set-add"><button class="set-btn set-btn-del" onclick="removeArmCustomField(${i})">Supprimer ce champ</button></div>
    </div>`;
  });
  html += `<div class="set-card">
    <div class="set-card-title">+ Ajouter un champ d'armoire</div>
    <input class="set-input" id="acf-new-label" placeholder="Nom du champ (ex : Marque du coffret)" style="margin-bottom:8px">
    <select class="set-input" id="acf-new-type" onchange="document.getElementById('acf-new-optrow').style.display=(this.value==='select'||this.value==='multi')?'flex':'none'" style="margin-bottom:8px">
      <option value="text">Texte libre</option>
      <option value="select">Liste de choix</option>
      <option value="multi">Liste à choix multiples</option>
    </select>
    <div class="set-add" id="acf-new-optrow" style="display:none;margin-bottom:8px">
      <input class="set-input" id="acf-new-options" placeholder="Options séparées par des virgules">
    </div>
    <button class="set-btn" onclick="addArmCustomField()">Créer le champ</button>
  </div>`;

  // Sections repliables : seul le titre est visible, on développe au tap
  const parts = html.split('<div class="set-section-title">');
  let out = parts[0];
  parts.slice(1).forEach(part => {
    const end = part.indexOf('</div>');
    const title = part.slice(0, end);
    const body = part.slice(end + 6);
    const open = _openSections.has(title);
    out += `<div class="set-sec">
      <div class="set-section-title set-sec-head" data-t="${title}" onclick="toggleSection(this)"><span class="set-caret">${open ? '▾' : '▸'}</span>${title}</div>
      <div class="set-sec-body" style="display:${open ? 'block' : 'none'}">${body}</div>
    </div>`;
  });
  box.innerHTML = out;
  setTimeout(initOrderDrag, 30);
  setTimeout(checkOfflineReady, 60);
}

/* ═══ MODE HORS-LIGNE : tableau de bord de préparation terrain ═══ */
async function checkOfflineReady() {
  const box = document.getElementById('offline-check');
  if (!box) return;
  const ligne = (ok, titre, detail) =>
    `<div class="set-color-row">
       <span class="set-color-label">${ok ? '✅' : '⚠️'} ${titre}</span>
       <span style="font-weight:600;color:${ok ? '#4ade80' : '#fbbf24'}">${detail}</span>
     </div>`;
  let pts = 0, arms = 0, tuiles = 0, trames = SHEET_TEMPLATES.length, queue = 0;
  try { pts = await DB.count('points'); } catch (e) {}
  try { arms = await DB.count('armoires'); } catch (e) {}
  try { const c = await caches.open('audit-ep-tiles-v1'); tuiles = (await c.keys()).length; } catch (e) {}
  try { queue = await DB.count('queue'); } catch (e) {}
  // état de l'appli en cache (shell installé)
  let shell = false;
  try { const keys = await caches.keys(); shell = keys.some(k => k.indexOf('audit-ep-shell') === 0); } catch (e) {}

  box.innerHTML =
    ligne(shell, 'Application installée hors-ligne', shell ? 'prête' : 'ouvrez en wifi') +
    ligne(pts > 0, 'Points du PEEEPS', pts + ' pts') +
    ligne(arms > 0, 'Armoires', arms + ' arm.') +
    ligne(trames > 0, 'Trames (catégories)', trames + ' trames') +
    ligne(tuiles > 50, 'Fond de carte', tuiles + ' tuiles' + (tuiles <= 50 ? ' — à précharger' : '')) +
    ligne(true, 'À synchroniser', queue === 0 ? 'rien en attente' : queue + ' en attente');

  const pret = shell && pts > 0 && trames > 0 && tuiles > 50;
  const t = document.querySelector('#offline-check');
  if (t) t.insertAdjacentHTML('afterbegin',
    `<div style="text-align:center;font-weight:700;margin-bottom:8px;color:${pret ? '#4ade80' : '#fbbf24'}">
       ${pret ? '✓ Prêt pour le terrain' : '⚠️ Préparation incomplète'}
     </div>`);
}

// Tout préparer d'un coup : rafraîchit les données du serveur + les trames + précharge la carte visible.
async function prepareOfflineAll() {
  if (!navigator.onLine) { showToast('Connectez-vous au wifi pour préparer le hors-ligne', 'error'); return; }
  showToast('Préparation en cours…', '');
  try { await loadFromSheets(true); } catch (e) {}          // points + armoires + config
  try { await loadTemplatesFromSheets(true); } catch (e) {} // trames (et sauvegarde locale)
  showToast('Données à jour ✓ — préchargez la carte de vos zones depuis l\'onglet Carte', 'success');
  // amène l'utilisateur à précharger la carte (l'action tuiles se fait sur la vue carte)
  await checkOfflineReady();
}
function addOption(key) {
  const inp = document.getElementById('addopt-' + key);
  const v = (inp.value || '').trim();
  if (!v) return;
  if (!CONFIG.lists[key]) CONFIG.lists[key] = [];
  if (!CONFIG.lists[key].includes(v)) CONFIG.lists[key].push(v);
  saveConfig(); renderSettings();
}
function removeOption(key, idx) {
  CONFIG.lists[key].splice(idx, 1);
  saveConfig(); renderSettings();
}
function slugify(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || ('champ_' + Date.now());
}
function changeCustomFieldType(i, type){
  const cf = CONFIG.customFields[i]; if (!cf) return;
  cf.type = type;
  if ((type === 'select' || type === 'multi') && !Array.isArray(cf.options)) cf.options = [];
  saveConfig(); renderSettings();
  showToast('Type modifié — ajoutez les options si besoin', 'success');
}
function renameCustomField(i){
  const cf = CONFIG.customFields[i]; if (!cf) return;
  const v = (prompt('Nom affiché dans la fiche :', cf.label) || '').trim();
  if (!v) return;
  cf.label = v;
  const col = (prompt('Colonne du Google Sheet à lire / écrire :\n(doit correspondre EXACTEMENT à l\u2019en-tête du tableur)', cf.column) || '').trim();
  if (col && col !== cf.column) {
    if ((CONFIG.customFields || []).some((c, j) => j !== i && c.column === col)) {
      showToast('Une autre colonne porte déjà ce nom', 'error'); return;
    }
    cf.column = col;
    showToast('Champ « ' + v + ' » relié à la colonne « ' + col + ' »', 'success');
  } else {
    showToast('Champ renommé', 'success');
  }
  saveConfig(); renderSettings();
}
function addCustomOption(i){
  const cf = CONFIG.customFields[i]; if (!cf) return;
  const inp = document.getElementById('addcfopt-' + i);
  const v = (inp && inp.value || '').trim();
  if (!v) return;
  cf.options = cf.options || [];
  if (!cf.options.includes(v)) cf.options.push(v);
  saveConfig(); renderSettings();
}
function removeCustomOption(i, oi){
  const cf = CONFIG.customFields[i]; if (!cf || !cf.options) return;
  cf.options.splice(oi, 1);
  saveConfig(); renderSettings();
}
function addCustomField() {
  const label = (document.getElementById('cf-new-label').value || '').trim();
  if (!label) { showToast('Donne un nom au champ', 'error'); return; }
  const type = document.getElementById('cf-new-type').value;
  const options = (type === 'select' || type === 'multi')
    ? (document.getElementById('cf-new-options').value || '').split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const key = slugify(label);
  if (CONFIG.customFields.some(c => c.key === key || c.column === label)) { showToast('Ce champ existe déjà', 'error'); return; }
  CONFIG.customFields.push({ key, label, column: label, type, options });
  saveConfig(); renderSettings();
  showToast('Champ « ' + label + ' » créé', 'success');
}
function removeCustomField(idx) {
  const cf = CONFIG.customFields[idx];
  if (!confirm('Retirer le champ « ' + cf.label + ' » du formulaire ?\nLa colonne et les données déjà dans le Sheet ne sont pas supprimées.')) return;
  CONFIG.customFields.splice(idx, 1);
  saveConfig(); renderSettings();
}
function addArmCustomField() {
  const label = (document.getElementById('acf-new-label').value || '').trim();
  if (!label) { showToast('Donne un nom au champ', 'error'); return; }
  const type = document.getElementById('acf-new-type').value;
  const options = (type === 'select' || type === 'multi')
    ? (document.getElementById('acf-new-options').value || '').split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const key = slugify(label);
  if (CONFIG.armCustomFields.some(c => c.key === key || c.column === label)) { showToast('Ce champ existe déjà', 'error'); return; }
  CONFIG.armCustomFields.push({ key, label, column: label, type, options });
  saveConfig(); renderSettings();
  showToast('Champ armoire « ' + label + ' » créé', 'success');
}
function removeArmCustomField(idx) {
  const cf = CONFIG.armCustomFields[idx];
  if (!confirm('Retirer le champ « ' + cf.label + ' » du formulaire armoire ?\nLa colonne et les données déjà dans le Sheet ne sont pas supprimées.')) return;
  CONFIG.armCustomFields.splice(idx, 1);
  saveConfig(); renderSettings();
}
function setStateColor(etat, color, channel) {
  if (!CONFIG.colors) CONFIG.colors = {};
  const cur = (typeof CONFIG.colors[etat] === 'object' && CONFIG.colors[etat]) ? CONFIG.colors[etat] : { fill: '#e2e8f0', border: '#ffffff' };
  cur[channel === 'border' ? 'border' : 'fill'] = color;
  CONFIG.colors[etat] = cur;
  saveConfig();
  refreshMapMarkers();
  renderList();
  renderPanier();
}
function setStateColorByIndex(i, color, channel) {
  const _cv = colorValuesFor(CONFIG.colorField);
  const val = _cv[i];
  if (val) setStateColor(val, color, channel);
}
function setColorField(field) {
  CONFIG.colorField = field;
  saveConfig();
  refreshMapMarkers();
  renderList();
  renderPanier();
  renderSettings();
}

/* Champs proposés dans « Une seule caractéristique » — construits dynamiquement
   à partir des listes réelles + des champs personnalisés (donc toujours à jour). */
function masseFieldDefs() {
  const L = CONFIG.lists || {};
  const defs = [
    { id:'f-type-support',     label:'Type de support',     key:'typeSupport',    options:L.typeSupport },
    { id:'f-etat-support',     label:'État du support',     key:'etatSupport',    options:L.etatSupport },
    { id:'f-hauteur',          label:'Hauteur',             key:'hauteur',        options:L.hauteur },
    { id:'f-type-attache',     label:"Type d'attache",      key:'typeAttache',    options:L.typeAttache },
    { id:'f-type-luminaire',   label:'Type de luminaire',   key:'typeLuminaire',  options:L.typeLuminaire },
    { id:'f-etat-luminaire',   label:'État luminaires',     key:'etatLuminaire',  options:L.etatLuminaire },
    { id:'f-technologie',      label:'Technologie',         key:'technologie',    options:L.technologie },
    { id:'f-nbr-supports',     label:'Nbr supports',        key:'nbrSupports',    options:null },
    { id:'f-nbr-luminaires',   label:'Nbr luminaires',      key:'nbrLuminaires',  options:null },
    { id:'f-puissance',        label:'Puissance',           key:'puissance',      options:null },
    { id:'f-id-armoire',       label:'ID Armoire',          key:'idArmoire',      options:null },
    { id:'f-classe-precision', label:'Classe de précision', key:'classePrecision',options:['C','B','A'] },
    { id:'f-observations',     label:'Observations',        key:'observations',   options:null },
  ];
  (CONFIG.customFields || []).forEach(cf => {
    defs.push({ id:'cf:' + cf.column, label:cf.label, custom:cf.column,
                options:(cf.type === 'select' || cf.type === 'multi') ? cf.options : null });
  });
  return defs;
}
function masseFieldById(id) { return masseFieldDefs().find(d => d.id === id); }
// Remplit la liste déroulante du modal (appelé à chaque ouverture)
function renderMasseFieldSelect() {
  const sel = document.getElementById('masse-field');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Sélectionner --</option>' +
    '<option value="__trame">🗂 Trame prédéfinie (toutes les caractéristiques)</option>' +
    masseFieldDefs().map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.label)}</option>`).join('');
}

document.getElementById('masse-field').addEventListener('change', function() {
  const f = this.value;
  const selRow = document.getElementById('masse-value-row');
  const txtRow = document.getElementById('masse-text-row');
  const sel = document.getElementById('masse-value');
  const tplBar = document.getElementById('masse-tpl-bar');
  if (tplBar) tplBar.style.display = 'none';
  if (f === '__trame') {
    selRow.style.display = 'none'; txtRow.style.display = 'none';
    if (tplBar) { renderMasseTplBar(); tplBar.style.display = 'flex'; }
    return;
  }
  const def = masseFieldById(f);
  if (def && def.options && def.options.length) {
    sel.innerHTML = def.options.map(o => `<option>${escapeHtml(o)}</option>`).join('');
    selRow.style.display = 'block'; txtRow.style.display = 'none';
  } else if (def) {
    selRow.style.display = 'none'; txtRow.style.display = 'block';
  } else {
    selRow.style.display = 'none'; txtRow.style.display = 'none';
  }
});

function openModalMasseChoice() {
  const pts = panierPoints();
  if (!pts.length) { showToast('Aucun point sélectionné', 'error'); return; }
  document.getElementById('masse-choice-count').textContent = pts.length;
  document.getElementById('modal-masse-choice').classList.add('open');
}
function closeModalMasseChoice(e) {
  if (!e || e.target === document.getElementById('modal-masse-choice'))
    document.getElementById('modal-masse-choice').classList.remove('open');
}

// Marque (ou retire) « vérifié sur le terrain » pour tous les points sélectionnés au lasso.
async function masseSetVerifie(val) {
  const cibles = panierPoints();
  if (!cibles.length) { showToast('Aucun point sélectionné', 'error'); return; }
  const entries = cibles.map(p => ({ id: p.id, before: cloneEntry(p) }));
  // 1) marquage LOCAL instantané
  cibles.forEach(p => { p.verifie = val; });
  saveLocal();
  pushUndo((val ? 'Vérification' : 'Retrait de vérification') + ' (' + cibles.length + ' pts)', entries);
  refreshMapMarkers();               // la barre de progression se met à jour tout de suite
  if (currentScreen === 'armoires') renderArmoires();

  // 2) envoi au Sheet en UN SEUL appel groupé (action 'masse') — pas 900 requêtes.
  const ids = cibles.map(p => p.id);
  if (!navigator.onLine) {
    showToast(cibles.length + ' point(s) ' + (val ? 'vérifiés ✓' : 'remis à non vérifié') + ' — seront synchronisés au réseau', 'success');
    // repli hors-ligne : on met chaque point dans la file classique
    for (const p of cibles) { try { await DB.put('queue', { id: p.id, pt: p, ts: Date.now() }); } catch (e) {} }
    return;
  }
  showToast(cibles.length + ' point(s) — envoi groupé au Sheet…', '');
  try {
    const res = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'masse', sheet: 'Points Lumineux', ids: ids, updates: { 'Vérifié': val ? 'OUI' : '' } })
    });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    showToast(cibles.length + ' point(s) ' + (val ? 'vérifiés ✓ (Sheet à jour)' : 'remis à non vérifié'), 'success');
  } catch (e) {
    // échec réseau : repli sur la file classique, ré-essayée automatiquement
    for (const p of cibles) { try { await DB.put('queue', { id: p.id, pt: p, ts: Date.now() }); } catch (er) {} }
    showToast('Marqué localement ✓ — synchronisation différée', '');
  }
}

// Retire tous les points du lasso (désélectionne) sans les supprimer
function deselectLasso() {
  const count = panierPoints().length;
  panierPoints().forEach(p => p.dansPanier = false);
  saveLocal();
  refreshMapMarkers();
  showToast(count + ' point' + (count > 1 ? 's' : '') + ' désélectionné' + (count > 1 ? 's' : ''), '');
}

// Demande confirmation avant suppression groupée
function confirmDeleteLasso() {
  const pts = panierPoints();
  if (!pts.length) return;
  document.getElementById('modal-masse-choice').classList.remove('open');
  if (!confirm('Supprimer définitivement ' + pts.length + ' point' + (pts.length > 1 ? 's' : '') + ' sélectionné' + (pts.length > 1 ? 's' : '') + ' ?\nCette action est irréversible.')) return;
  pts.forEach(p => deletePointLocal(p.id));
  showToast(pts.length + ' point' + (pts.length > 1 ? 's' : '') + ' supprimé' + (pts.length > 1 ? 's' : ''), 'success');
}

// Correspondance champ de fiche → propriété du point (trames + masse)
const FIELD_TO_KEY = {
  'f-nbr-supports': 'nbrSupports', 'f-type-support': 'typeSupport', 'f-etat-support': 'etatSupport',
  'f-hauteur': 'hauteur', 'f-type-attache': 'typeAttache', 'f-nbr-luminaires': 'nbrLuminaires',
  'f-type-luminaire': 'typeLuminaire', 'f-etat-luminaire': 'etatLuminaire',
  'f-technologie': 'technologie', 'f-puissance': 'puissance'
};
function renderMasseTplBar() {
  const bar = document.getElementById('masse-tpl-bar');
  if (!bar) return;
  const tpls = getAllTemplates();
  if (!tpls.length) { bar.innerHTML = '<div class="set-empty" style="padding:8px">Aucune trame — créez-en dans Réglages ou dans l\u2019onglet « Trames » du Sheet.</div>'; return; }
  bar.innerHTML = tpls.map((t, i) => `
    <div class="tpl-card" style="${t.color ? 'border:2px solid ' + t.color : ''}" onclick="applyTemplateToSelection(${i})">
      ${tplThumbHTML(t)}
      <div class="tpl-name">${escapeHtml(t.name)}</div>
    </div>`).join('');
}
const _FID_LIST = { 'f-type-support':'typeSupport','f-etat-support':'etatSupport','f-type-attache':'typeAttache','f-type-luminaire':'typeLuminaire','f-etat-luminaire':'etatLuminaire','f-technologie':'technologie','f-hauteur':'hauteur' };
function _resolveOption(fid, v){
  const listKey = _FID_LIST[fid];
  if (!listKey || !CONFIG.lists[listKey]) return v;
  const want = _normVal(v);
  return CONFIG.lists[listKey].find(o => _normVal(o) === want) || v;
}
async function applyTemplateToSelection(i) {
  const t = getAllTemplates()[i];
  if (!t) return;
  const targets = panierPoints();
  if (!targets.length) { showToast('Aucun point sélectionné', 'error'); return; }
  targets.forEach(p => {
    Object.entries(t.values || {}).forEach(([fid, v]) => {
      const key = FIELD_TO_KEY[fid];
      if (key) p[key] = _resolveOption(fid, v);
    });
    if (t.custom && Object.keys(t.custom).length) {
      p.custom = Object.assign({}, p.custom || {}, t.custom);
    }
  });
  saveLocal(); closeModalMasse(); renderPanier(); refreshMapMarkers();
  showToast('Trame « ' + t.name + ' » appliquée à ' + targets.length + ' point' + (targets.length > 1 ? 's' : '') + ' — sync…', 'success');
  for (const p of targets) { await syncPointToSheets(p); }
  updateStatus();
}
function openModalMasseTrames() {
  openModalMasse();
  const f = document.getElementById('masse-field');
  if (f) f.value = '__trame';
  document.getElementById('masse-value-row').style.display = 'none';
  document.getElementById('masse-text-row').style.display = 'none';
  const bar = document.getElementById('masse-tpl-bar');
  if (bar) { renderMasseTplBar(); bar.style.display = 'flex'; }
}
function openModalMasse() {
  const pts = panierPoints();
  if (!pts.length) { showToast('Aucun point sélectionné', 'error'); return; }
  document.getElementById('masse-count').textContent = pts.length;
  renderMasseFieldSelect();
  document.getElementById('masse-field').value = '';
  document.getElementById('masse-value-row').style.display = 'none';
  document.getElementById('masse-text-row').style.display = 'none';
  const _mtb = document.getElementById('masse-tpl-bar');
  if (_mtb) _mtb.style.display = 'none';
  document.getElementById('modal-masse').classList.add('open');
}
function closeModalMasse(e) {
  if (!e || e.target === document.getElementById('modal-masse'))
    document.getElementById('modal-masse').classList.remove('open');
}
async function applyMasse() {
  const field = document.getElementById('masse-field').value;
  if (field === '__trame') { showToast('Touchez une trame dans le bandeau pour l\u2019appliquer', 'error'); return; }
  const def = masseFieldById(field);
  if (!field || !def) { showToast('Sélectionnez un champ', 'error'); return; }
  const value = (def.options && def.options.length)
    ? document.getElementById('masse-value').value
    : document.getElementById('masse-text').value.trim();
  const targets = panierPoints();
  if (!targets.length) { showToast('Aucun point sélectionné', 'error'); return; }
  const entries = targets.map(p => ({ id: p.id, before: cloneEntry(p) }));
  targets.forEach(p => {
    if (def.custom) { p.custom = p.custom || {}; p.custom[def.custom] = value; }
    else p[def.key] = value;
  });
  pushUndo('Modif. masse (' + targets.length + ' pts)', entries);
  saveLocal(); closeModalMasse(); renderPanier(); refreshMapMarkers();
  showToast(targets.length + ' point' + (targets.length > 1 ? 's' : '') + ' modifié' + (targets.length > 1 ? 's' : '') + ' — sync…', 'success');
  for (const p of targets) { await syncPointToSheets(p); }
  updateStatus();
}

// ── MODAL MASSE — toutes les caractéristiques en une fois ──
const masseAllFields = [
  ['ma-id-armoire', 'idArmoire', 'text'],
  ['ma-nbr-supports', 'nbrSupports', 'text'],
  ['ma-type-support', 'typeSupport', 'text'],
  ['ma-etat-support', 'etatSupport', 'text'],
  ['ma-hauteur', 'hauteur', 'text'],
  ['ma-type-attache', 'typeAttache', 'text'],
  ['ma-nbr-luminaires', 'nbrLuminaires', 'text'],
  ['ma-type-luminaire', 'typeLuminaire', 'text'],
  ['ma-etat-luminaire', 'etatLuminaire', 'text'],
  ['ma-technologie', 'technologie', 'text'],
  ['ma-puissance', 'puissance', 'text'],
  ['ma-classe-precision', 'classePrecision', 'text'],
  ['ma-observations', 'observations', 'text'],
];
function openModalMasseAll() {
  const pts = panierPoints();
  if (!pts.length) { showToast('Aucun point sélectionné', 'error'); return; }
  document.getElementById('masse-all-count').textContent = pts.length;
  document.getElementById('masse-all-count2').textContent = pts.length;
  masseAllFields.forEach(([id]) => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('modal-masse-all').classList.add('open');
}
function closeModalMasseAll(e) {
  if (!e || e.target === document.getElementById('modal-masse-all'))
    document.getElementById('modal-masse-all').classList.remove('open');
}
async function applyMasseAll() {
  const targets = panierPoints();
  if (!targets.length) { showToast('Aucun point sélectionné', 'error'); return; }
  const patch = {};
  masseAllFields.forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const v = el.value.trim();
    if (v !== '') patch[key] = v;
  });
  if (!Object.keys(patch).length) { showToast('Aucun champ rempli', 'error'); return; }
  const entries = targets.map(p => ({ id: p.id, before: cloneEntry(p) }));
  targets.forEach(p => { Object.assign(p, patch); });
  pushUndo('Modif. masse (' + targets.length + ' pts)', entries);
  saveLocal(); closeModalMasseAll(); renderPanier(); refreshMapMarkers();
  showToast(targets.length + ' point' + (targets.length > 1 ? 's' : '') + ' modifié' + (targets.length > 1 ? 's' : '') + ' — sync…', 'success');
  for (const p of targets) { await syncPointToSheets(p); }
  updateStatus();
}

updateOfflineBanner();

// ── GOOGLE APPS SCRIPT CONFIG ──
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbww2iZN21IM53ikvY1QigN9qewDYodvd3GsgGEHGBHjq34GexDIUIneUvHhNjYucCc8/exec';

let syncQueue = [];
let isSyncing = false;

// ── LIRE les données depuis Apps Script ──
// Lecture tolérante d'une colonne : essai exact, puis en ignorant casse/accents/espaces/underscores.
const _colCache = new WeakMap();
function colVal(r, name) {
  if (r[name] !== undefined) return r[name];
  let idx = _colCache.get(r);
  if (!idx) {
    idx = {};
    const norm = k => String(k).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
    Object.keys(r).forEach(k => { idx[norm(k)] = k; });
    _colCache.set(r, idx);
  }
  const nn = String(name).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const k = idx[nn];
  return k !== undefined ? r[k] : undefined;
}
// ── LIRE les armoires depuis le Sheet (redescente serveur → app) ──
function mapServerArmoire(r) {
  const custom = {};
  (CONFIG.armCustomFields || []).forEach(cf => { const v = colVal(r, cf.column); if (v !== undefined) custom[cf.column] = v; });
  const photos = {};
  const ph = String(r['Photos'] || '');
  ARM_PHOTO_TYPES.forEach(t => { photos[t] = ph.indexOf(t) >= 0; });
  return {
    id: String(r['ID'] || ''),
    etatExt: r["État Ext de l'armoire"] || '',
    etatInt: r["État Int de l'armoire"] || '',
    abonnement: r['Abonnement (kVA)'] || '',
    cable: r["Câble d'alimentation"] || '',
    departs: r['Départs'] || '',
    protection: r['Protection'] || '',
    horloge: r['Horloge'] || '',
    observations: r['Observations'] || '',
    lng: parseFloat(r['Longitude']) || null,
    lat: parseFloat(r['Latitude']) || null,
    chantier: r['Chantier'] || '',
    technicien: r['Technicien'] || '',
    date: r['Date'] || '',
    custom, photos
  };
}
function armSig(a) {
  return JSON.stringify([a.etatExt, a.etatInt, a.abonnement, a.cable, a.departs,
    a.protection, a.horloge, a.observations, a.lat, a.lng, a.custom || {}]);
}
async function loadArmoiresFromSheets(silent) {
  if (!navigator.onLine) return;
  const _ch = state.chantier;
  try {
    const url = SCRIPT_URL + '?sheet=Armoires&chantier=' + encodeURIComponent(_ch);
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const byId = new Map(state.armoires.map(a => [String(a.id), a]));
    const pendingArm = new Set(), pendingDel = new Set();
    let tomb = new Set();
    try {
      (await DB.all('queue')).forEach(it => {
        if (it.kind === 'armoire' && it.pt) pendingArm.add(String(it.pt.id));
        if (it.kind === 'del' && it.sheet === 'Armoires') pendingDel.add(String(it.targetId));
      });
    } catch (e) {}
    try { tomb = new Set((await DB.all('tombstones')).map(t => String(t.id))); } catch (e) {}
    if (state.chantier !== _ch) return;   // PEEEPS changé pendant le chargement : réponse abandonnée
    let changed = 0;
    const serverIds = new Set();
    (data.rows || []).forEach(r => {
      const id = String(r['ID'] || '');
      if (!id) return;
      serverIds.add(id);
      if (tomb.has('ARM__' + id) || pendingDel.has(id)) return;   // supprimée sur cet appareil
      const srv = mapServerArmoire(r);
      const loc = byId.get(id);
      if (!loc) { byId.set(id, srv); changed++; }
      else if (!pendingArm.has(id) && armSig(loc) !== armSig(srv)) {
        byId.set(id, Object.assign({}, loc, srv, { photos: Object.assign({}, srv.photos, loc.photos) }));
        changed++;
      }
    });
    // Réconciliation descendante : armoire supprimée du Sheet → retirée localement
    for (const a of [...byId.values()]) {
      const id = String(a.id);
      if (String(a.chantier) === String(_ch) && !serverIds.has(id) && !pendingArm.has(id) && !pendingDel.has(id)) {
        byId.delete(id);
        changed++;
      }
    }
    if (changed) {
      state.armoires = [...byId.values()];
      saveLocalArmoires();
      refreshMapMarkers();
      if (currentScreen === 'armoires') renderArmoires();
      if (!silent) showToast(state.armoires.length + ' armoire' + (state.armoires.length > 1 ? 's' : '') + ' synchronisée(s) ✓', 'success');
    }
  } catch (e) { console.warn('load armoires:', e); }
}

/* ═══════════ RÉGLAGES PARTAGÉS ENTRE APPAREILS (onglet "Config" du Sheet) ═══════════
   La config complète (trames, listes, couleurs, ordre, champs perso) est stockée en JSON
   découpé sur des colonnes JSON1..JSON10 d'une ligne unique. Dernier enregistrement gagne. */
let _cfgTabWarned = false;
function _cfgTabMissing(e) {
  if (!_cfgTabWarned && String(e).indexOf('Sheet not found') >= 0) {
    _cfgTabWarned = true;
    showToast('Ajoutez un onglet « Config » dans le Sheet pour partager les réglages', 'error');
  }
}
let _configPushing = false;
let _configDirty = false;
async function pushConfigToSheets() {
  _configPushing = true; _configDirty = true;
  if (!navigator.onLine) return;   // repoussé par la synchro suivante (horodatage local plus récent)
  try {
    const json = JSON.stringify(CONFIG);
    const data = { 'ID': 'config', 'Updated': CONFIG.updatedAt || 0 };
    const CHUNK = 45000;           // limite Google Sheets ≈ 50 000 caractères par cellule
    if (json.length > CHUNK * 20) { showToast('Réglages trop volumineux pour le partage — retirez des photos de trames', 'error'); return; }
    for (let i = 0; i < 20; i++) data['JSON' + (i + 1)] = json.slice(i * CHUNK, (i + 1) * CHUNK);
    const res = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'upsert', sheet: 'Config', id: 'config', data })
    });
    const r = await res.json();
    if (r.error) throw new Error(r.error);
  } catch (e) { console.warn('push config:', e); _cfgTabMissing(e); }
  finally { _configPushing = false; }
}
async function syncConfigWithSheets(silent) {
  if (!navigator.onLine) return;
  if (_configPushing) return;   // une écriture locale est en cours → on ne lit pas maintenant
  try {
    const res = await fetch(SCRIPT_URL + '?sheet=Config');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const row = (data.rows || []).find(r => String(r['ID']) === 'config');
    if (!row) { if ((CONFIG.updatedAt || 0) > 0) pushConfigToSheets(); return; }
    const remoteTs = Number(row['Updated']) || 0;
    const localTs = CONFIG.updatedAt || 0;
    if (remoteTs > localTs) {
      let json = '';
      for (let i = 1; i <= 20; i++) json += String(row['JSON' + i] || '');
      const parsed = JSON.parse(json);
      // FUSION ADDITIVE des listes et options : on ne perd jamais une option ajoutée localement.
      const localLists = JSON.parse(JSON.stringify(CONFIG.lists || {}));
      const localCF = JSON.parse(JSON.stringify(CONFIG.customFields || []));
      if (parsed.lists) {
        Object.keys(localLists).forEach(k => {
          const merged = (parsed.lists[k] || []).slice();
          localLists[k].forEach(o => { if (!merged.includes(o)) merged.push(o); });
          parsed.lists[k] = merged;
        });
      }
      if (Array.isArray(parsed.customFields)) {
        localCF.forEach(lcf => {
          const rcf = parsed.customFields.find(c => c.column === lcf.column);
          if (rcf && Array.isArray(lcf.options)) {
            rcf.options = rcf.options || [];
            lcf.options.forEach(o => { if (!rcf.options.includes(o)) rcf.options.push(o); });
          } else if (!rcf) {
            parsed.customFields.push(lcf);   // champ perso créé localement, absent du serveur
          }
        });
      }
      await DB.put('meta', { k: 'config', v: parsed });
      await loadConfig();
      if (_configDirty) pushConfigToSheets();      // on repartage la version fusionnée
      if (currentScreen === 'settings') renderSettings();
      if (!silent) showToast('Réglages synchronisés ✓', 'success');
    } else if (localTs > remoteTs) {
      pushConfigToSheets();                        // cet appareil est plus récent → il partage
    }
  } catch (e) { console.warn('sync config:', e); _cfgTabMissing(e); }
}

function mapServerRow(r) {
  const custom = {};
  (CONFIG.customFields || []).forEach(cf => {
    const v = colVal(r, cf.column);
    if (v !== undefined) custom[cf.column] = v;
  });
  return {
    id: String(r['ID'] || ''),
    idArmoire: String(colVal(r, 'ID Armoire') || '').trim(),
    classePrecision: colVal(r, 'Classe de precision') || '',
    sourcePosition: colVal(r, 'Source position') || '',
    gpsAccuracy: (r['Exactitude_m'] !== '' && r['Exactitude_m'] != null) ? Number(r['Exactitude_m']) : null,
    nbrSupports: r['Nbr supports'] || '',
    typeSupport: r['Types de support'] || '',
    etatSupport: r['État du support'] || '',
    hauteur: r['Hauteur'] || '',
    typeAttache: r["Types d'attache"] || '',
    nbrLuminaires: r['Nbr Luminaires'] || '',
    typeLuminaire: r['Types de luminaire'] || '',
    etatLuminaire: r['État luminaires'] || '',
    technologie: r['Technologie'] || '',
    puissance: r['Puissance'] || '',
    lng: parseFloat(r['Longitude']) || null,
    lat: parseFloat(r['Latitude']) || null,
    dansPanier: r['Dans le Panier'] === 'TRUE' || r['Dans le Panier'] === true,
    aDeposer: String(colVal(r, 'À déposer') || '').toUpperCase() === 'OUI',
    verifie: String(colVal(r, 'Vérifié') || '').toUpperCase() === 'OUI',
    observations: colVal(r, 'Observations') || '',
    _categorieSheet: String(colVal(r, 'Catégorie') || '').trim(),
    chantier: r['Chantier'] || '',
    technicien: r['Technicien'] || '',
    date: r['Date'] || '',
    custom: custom,
    photos: {}
  };
}
// Applique les valeurs d'une trame à un point pour ses champs restés vides (non destructif).
function applyCategorieToPoint(pt){
  const name = pt._categorieSheet || (pt.custom && pt.custom['Catégorie']) || '';
  if (!name) return pt;
  const t = (typeof getAllTemplates === 'function') ? getAllTemplates().find(x => x.name.toLowerCase() === String(name).toLowerCase()) : null;
  if (!t) return pt;
  const F2K = { 'f-nbr-supports':'nbrSupports','f-type-support':'typeSupport','f-etat-support':'etatSupport','f-hauteur':'hauteur','f-type-attache':'typeAttache','f-nbr-luminaires':'nbrLuminaires','f-type-luminaire':'typeLuminaire','f-etat-luminaire':'etatLuminaire','f-technologie':'technologie','f-puissance':'puissance' };
  Object.entries(t.values || {}).forEach(([fid, v]) => {
    const k = F2K[fid];
    if (k && (pt[k] === '' || pt[k] == null)) pt[k] = (typeof _resolveOption === 'function') ? _resolveOption(fid, v) : v;
  });
  Object.entries(t.custom || {}).forEach(([col, v]) => {
    if (!pt.custom) pt.custom = {};
    if (pt.custom[col] === '' || pt.custom[col] == null) pt.custom[col] = v;
  });
  if (!pt.custom) pt.custom = {};
  if (!pt.custom['Catégorie']) pt.custom['Catégorie'] = name;
  return pt;
}
// ── Polling automatique : reflète les modifs faites dans le Sheet (ajouts ET suppressions) ──
let pollTimer = null, isLoading = false;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (navigator.onLine && !isLoading && document.visibilityState === 'visible') loadFromSheets(true);
  }, 30000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Bouton "Synchroniser" du bandeau : force un aller-retour immédiat avec le Sheet ──
async function manualSync() {
  const btn = document.getElementById('sync-btn');
  if (btn.classList.contains('spinning')) return; // déjà en cours
  if (!navigator.onLine) { showToast('Hors ligne — synchronisation impossible pour le moment', ''); return; }
  btn.classList.add('spinning');
  btn.disabled = true;
  try {
    await loadFromSheets(false);
  } finally {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }
}

async function loadFromSheets(silent) {
  if (isLoading) return;                 // évite les chargements qui se chevauchent
  isLoading = true;
  const _ch = state.chantier;            // PEEEPS pour lequel on charge (peut changer pendant l'attente réseau)
  try {
    if (!silent) {                       // au polling silencieux, la mémoire est déjà la source de vérité
      await loadLocal();                 // points locaux d'abord = source de vérité hors-ligne
      refreshMapMarkers();
    }
    if (!navigator.onLine) return;
    try {
      if (!silent) showToast('Synchronisation serveur…');
      // Les trames doivent être connues AVANT de lire les points : la colonne « Catégorie »
      // du Sheet a besoin de la trame correspondante pour compléter la fiche.
      if (!SHEET_TEMPLATES.length) { try { await loadTemplatesFromSheets(true); } catch (e) {} }
      const url = SCRIPT_URL + '?sheet=Points%20Lumineux&chantier=' + encodeURIComponent(_ch);
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const byId = new Map(state.points.map(p => [String(p.id), p]));
      let tombstones = new Set();
      try { tombstones = new Set((await DB.all('tombstones')).map(t => t.id)); } catch (e) {}
      let pendingIds = new Set();
      try { pendingIds = new Set((await DB.all('queue')).map(q => String(q.id))); } catch (e) {}
      if (state.chantier !== _ch) return;   // PEEEPS changé pendant le chargement : réponse abandonnée

      // 1) Ajouts : points du serveur absents en local (hors supprimés/tombstones)
      let added = 0;
      (data.rows || []).forEach(r => {
        const id = String(r['ID'] || '');
        if (!id || byId.has(id) || tombstones.has(id)) return;
        byId.set(id, applyCategorieToPoint(mapServerRow(r)));
        added++;
      });

      // 1bis) Mises à jour : points déjà connus en local dont les champs (coordonnées
      //       GPS incluses) ont changé côté Sheet — ex. correction en masse dans Excel.
      //       Garde-fou : on ne touche JAMAIS un point qui a une modif locale en attente
      //       de sync (queue), pour ne pas écraser une saisie terrain pas encore remontée.
      let updated = 0;
      (data.rows || []).forEach(r => {
        const id = String(r['ID'] || '');
        if (!id || tombstones.has(id) || pendingIds.has(id)) return;
        const existing = byId.get(id);
        if (!existing) return; // pas encore en local → déjà géré par l'ajout ci-dessus
        const fresh = applyCategorieToPoint(mapServerRow(r));
        fresh.photos = existing.photos;       // indicateurs photos gérés en local (IndexedDB), pas dans le Sheet
        fresh.dansPanier = existing.dansPanier; // le panier est une sélection LOCALE : jamais écrasée par le serveur
        const changed = fresh.lat !== existing.lat || fresh.lng !== existing.lng
          || JSON.stringify(fresh) !== JSON.stringify(Object.assign({}, existing, { photos: fresh.photos, dansPanier: fresh.dansPanier }));
        if (changed) { byId.set(id, fresh); updated++; }
      });

      // 2) Réconciliation descendante : retirer en local les points de CE chantier
      //    disparus du Sheet. Garde-fous : JAMAIS un point en attente de sync (posé
      //    hors-ligne, pas encore remonté) ni un point d'un autre chantier. Ne s'exécute
      //    que si le serveur a répondu correctement → aucune coupure réseau ne peut effacer.
      const serverIds = new Set((data.rows || []).map(r => String(r['ID'] || '')));
      let removed = 0;
      for (const p of [...byId.values()]) {
        const pid = String(p.id);
        if (String(p.chantier) === String(_ch) && !serverIds.has(pid) && !pendingIds.has(pid)) {
          byId.delete(pid);
          try { await DB.del('points', p.id); } catch (e) {}
          removed++;
        }
      }

      if (added || updated || removed) {   // rien à faire si le serveur n'a rien de neuf
        state.points = [...byId.values()];
        saveLocal();
        refreshMapMarkers();
      }

      if (removed) showToast(removed + ' point' + (removed > 1 ? 's' : '') + ' retiré' + (removed > 1 ? 's' : '') + ' (supprimé du Sheet)', '');
      else if (added || updated) {
        const parts = [];
        if (added) parts.push(added + ' ajouté' + (added > 1 ? 's' : ''));
        if (updated) parts.push(updated + ' mis à jour');
        showToast(parts.join(' · ') + ' ✓', 'success');
      }
      else if (!silent) showToast('À jour ✓', 'success');
    } catch (e) {
      console.error('Load error:', e);
      if (!silent) showToast('Mode hors-ligne', '');
    }
    await loadArmoiresFromSheets(silent);   // redescend aussi les armoires du Sheet
    await syncConfigWithSheets(silent);     // réglages partagés (trames, listes, couleurs…)
    await loadTemplatesFromSheets(silent);  // trames du tableau "Trames" du Sheet
    flushSyncQueue();                    // pousse les points locaux en attente
  } finally {
    isLoading = false;
  }
}

// ── ÉCRIRE un point via Apps Script ──
// ── Retry avec backoff exponentiel (échec serveur alors qu'on est en ligne) ──
// Le seul listener 'online' ne suffit pas : si une erreur survient pendant
// qu'on est déjà en ligne (timeout Apps Script, erreur 5xx...), rien ne
// redéclenchait de nouvelle tentative avant la prochaine action manuelle.
let syncBackoffMs = 5000;
const SYNC_BACKOFF_MAX = 5 * 60 * 1000;
let syncRetryTimer = null;
function scheduleSyncRetry() {
  if (syncRetryTimer) return; // une tentative est déjà programmée
  syncRetryTimer = setTimeout(() => {
    syncRetryTimer = null;
    flushSyncQueue();
  }, syncBackoffMs);
  syncBackoffMs = Math.min(syncBackoffMs * 2, SYNC_BACKOFF_MAX);
}
function resetSyncBackoff() { syncBackoffMs = 5000; }

// Construit l'objet de colonnes d'un point (réutilisé pour l'envoi unitaire ET groupé).
function pointToData(pt) {
  let coordsGPS = '';
  if (pt.lat != null && pt.lng != null) coordsGPS = pt.lat + ', ' + pt.lng;
  const d = {
    'ID': pt.id,
    'ID Armoire': pt.idArmoire || '',
    'Classe de precision': pt.classePrecision || '',
    'Source position': pt.sourcePosition || '',
    'Exactitude_m': pt.gpsAccuracy != null ? pt.gpsAccuracy : '',
    'Nbr supports': pt.nbrSupports,
    'Types de support': pt.typeSupport,
    'État du support': pt.etatSupport,
    'Hauteur': pt.hauteur,
    "Types d'attache": pt.typeAttache,
    'Nbr Luminaires': pt.nbrLuminaires,
    'Types de luminaire': pt.typeLuminaire,
    'État luminaires': pt.etatLuminaire,
    'Technologie': pt.technologie,
    'Puissance': pt.puissance,
    'Longitude': pt.lng || '',
    'Latitude': pt.lat || '',
    'Coordonnees_GPS': coordsGPS,
    'Photos': PHOTO_TYPES.filter(t => pt.photos && pt.photos[t]).join(','),
    'Dans le Panier': pt.dansPanier ? 'TRUE' : 'FALSE',
    'À déposer': pt.aDeposer ? 'OUI' : '',
    'Vérifié': pt.verifie ? 'OUI' : '',
    'Observations': pt.observations || '',
    'Chantier': pt.chantier,
    'Technicien': pt.technicien,
    'Date': pt.date
  };
  if (pt.custom) Object.assign(d, pt.custom);
  return d;
}
async function syncPointToSheets(pt) {
  if (!navigator.onLine) {
    await enqueuePoint(pt);
    showToast('Hors ligne — en file de sync', '');
    updateStatus();
    return;
  }
  try {
    const coordsGPS = pt.lat && pt.lng ? Number(pt.lat).toFixed(6) + ', ' + Number(pt.lng).toFixed(6) : '';
    const payload = { action: 'upsert', sheet: 'Points Lumineux', id: pt.id, data: pointToData(pt) };
    const res = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    try { await DB.del('queue', pt.id); } catch (e) {}
    resetSyncBackoff();
    showToast('Synchronisé ✓', 'success');
    updateStatus();
  } catch(e) {
    console.error('Sync error:', e);
    await enqueuePoint(pt);
    showToast('Sauvé local — sync au retour réseau', '');
    updateStatus();
    if (navigator.onLine) scheduleSyncRetry(); // erreur serveur, pas juste hors-ligne
  }
}

async function refreshTilesInfo(){
  try {
    const c = await caches.open('audit-ep-tiles-v1');
    const keys = await c.keys();
    const el = document.getElementById('set-tiles-count'); if (el) el.textContent = keys.length + ' tuile(s)';
    // estimation : ~12 Ko/tuile en moyenne
    const mb = (keys.length * 12 / 1024).toFixed(1);
    const es = document.getElementById('set-tiles-size'); if (es) es.textContent = '~ ' + mb + ' Mo';
    // si l'API de stockage existe, on affiche le vrai chiffre
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est && est.usage && es) es.textContent = '~ ' + (est.usage/1048576).toFixed(0) + ' Mo (total app)';
    }
  } catch (e) {}
}
async function clearTileCache() {
  // Sécurités : jamais pendant un téléchargement, jamais hors-ligne (les cartes seraient irrécupérables)
  const pc = document.getElementById('cache-progress');
  if (_dlRunning || (pc && pc.classList.contains('show'))) { showToast('Un téléchargement de carte est en cours — attendez la fin ou annulez-le', 'error'); return; }
  if (!navigator.onLine) { showToast('Hors ligne : vider les cartes les rendrait irrécupérables. Reconnectez-vous d\u2019abord.', 'error'); return; }
  let n = 0;
  try { n = (await (await caches.open(TILE_CACHE_NAME)).keys()).length; } catch (e) {}
  if (!n) { showToast('Aucune carte téléchargée à vider', ''); return; }
  if (!confirm('Vider les ' + n + ' tuiles de carte téléchargées ?\n\nCela libère de l\u2019espace. Vos points, photos et réglages ne sont PAS touchés.\nIl faudra re-précharger les zones pour les revoir hors ligne.')) return;
  try {
    await caches.delete(TILE_CACHE_NAME);   // uniquement le cache des tuiles (jamais celui de l'application)
    showToast('Cartes téléchargées vidées ✓', 'success');
  } catch (e) { showToast('Impossible de vider le cache', 'error'); }
  refreshTilesInfo();
  refreshDiag();
}

// ── VIDER la file d'attente hors-ligne ──
/* ════════ HÉBERGEMENT DES PHOTOS (Drive via Apps Script) ════════
   Chaque photo sauvée localement est mise en file (photoQueue), puis envoyée
   en base64 au script qui la range dans Drive et écrit l'URL dans la colonne
   du Sheet. Fonctionne hors-ligne : l'envoi part au retour du réseau. */
const PHOTO_COLS = { luminaire: 'Photo du Luminaire', mat: 'Photo du mât', classe2: 'Photo du classe 2' };
const ARM_PHOTO_COLS = { arm_ext: 'Photos Extérieur', arm_int: 'Photos Intérieur', arm_compteur: 'Photo Compteur' };

async function enqueuePhoto(ownerId, type, sheet, column, armoire) {
  try {
    await DB.put('photoQueue', { key: ownerId + '__' + type, ownerId, type, sheet, column, armoire: armoire || '', chantier: state.chantier || '', ts: Date.now() });
  } catch (e) { console.error('enqueuePhoto', e); }
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(new Error('read failed'));
    fr.readAsDataURL(blob);
  });
}
let isUploadingPhotos = false;
let lastPhotoError = '';   // dernier refus serveur, lisible dans le diagnostic
async function uploadPendingPhotos() {
  if (isUploadingPhotos || !navigator.onLine) return;
  isUploadingPhotos = true;
  try {
    let items = [];
    try { items = await DB.all('photoQueue'); } catch (e) {}
    let firstErr = null;
    for (const it of items) {
      if (!navigator.onLine) break;
      let rec = null;
      try { rec = await DB.get('photos', it.key); } catch (e) {}
      if (!rec || !rec.blob) { try { await DB.del('photoQueue', it.key); } catch (e) {} continue; }
      try {
        const b64 = await blobToBase64(rec.blob);
        const ctl = new AbortController();
        const tmo = setTimeout(() => ctl.abort(), 45000);   // 45 s max par photo : un envoi suspendu ne bloque plus tout
        const res = await fetch(SCRIPT_URL, {
          method: 'POST',
          signal: ctl.signal,
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({
            action: 'photo',
            sheet: it.sheet,
            id: it.ownerId,
            column: it.column,
            armoire: it.armoire || '',
            filename: it.ownerId + '__' + it.type + '.jpg',
            mime: 'image/jpeg',
            chantier: it.chantier || state.chantier || '',
            data: b64
          })
        });
        clearTimeout(tmo);
        const result = await res.json();
        if (result.error) throw new Error(result.error);
        await DB.del('photoQueue', it.key);
      } catch (e) {
        console.warn('upload photo différé:', e);
        if (!firstErr) firstErr = e;
        continue; // on passe à la suivante ; celle-ci sera retentée au prochain passage
      }
    }
    if (firstErr) {
      lastPhotoError = new Date().toLocaleTimeString() + ' — ' + String(firstErr.message || firstErr);
      // Fait remonter la raison exacte du blocage à l'écran (diagnostic terrain)
      showToast('Photo refusée : ' + String(firstErr.message || firstErr).slice(0, 90), 'error');
    }
  } finally { isUploadingPhotos = false; updateStatus(); }
}

// ── Suppression côté serveur (avec file hors-ligne) ──
async function sendDeleteToSheets(sheet, targetId) {
  const qid = 'del__' + sheet + '__' + targetId;
  if (!navigator.onLine) {
    try { await DB.put('queue', { id: qid, kind: 'del', sheet, targetId, ts: Date.now() }); } catch (e) {}
    updateStatus();
    return false;
  }
  try {
    const res = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'delete', sheet, id: targetId })
    });
    const result = await res.json().catch(() => ({}));
    if (result && result.error) throw new Error(result.error);
    try { await DB.del('queue', qid); } catch (e) {}
    return true;
  } catch (e) {
    console.warn('delete serveur différé:', e);
    try { await DB.put('queue', { id: qid, kind: 'del', sheet, targetId, ts: Date.now() }); } catch (e2) {}
    updateStatus();
    if (navigator.onLine) scheduleSyncRetry();
    return false;
  }
}

// ── SYNC ARMOIRE vers l'onglet "Armoires" du Sheet ──
async function syncArmoireToSheets(arm) {
  const qid = 'arm__' + arm.id;
  const enq = async () => { try { await DB.put('queue', { id: qid, kind: 'armoire', pt: arm, ts: Date.now() }); } catch (e) {} };
  if (!navigator.onLine) { await enq(); updateStatus(); return; }
  try {
    const coordsGPS = arm.lat && arm.lng ? Number(arm.lat).toFixed(6) + ', ' + Number(arm.lng).toFixed(6) : '';
    const payload = {
      action: 'upsert',
      sheet: 'Armoires',
      id: arm.id,
      data: {
        'ID': arm.id,
        "État Ext de l'armoire": arm.etatExt || '',
        "État Int de l'armoire": arm.etatInt || '',
        'Abonnement (kVA)': arm.abonnement || '',
        "Câble d'alimentation": arm.cable || '',
        'Départs': arm.departs || '',
        'Protection': arm.protection || '',
        'Horloge': arm.horloge || '',
        'Observations': arm.observations || '',
        'Longitude': arm.lng || '',
        'Latitude': arm.lat || '',
        'Coordonnees_GPS': coordsGPS,
        'Photos': ARM_PHOTO_TYPES.filter(t => arm.photos && arm.photos[t]).join(','),
        'Chantier': arm.chantier || '',
        'Technicien': arm.technicien || '',
        'Date': arm.date || ''
      }
    };
    if (arm.custom) Object.assign(payload.data, arm.custom);
    const res = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    try { await DB.del('queue', qid); } catch (e) {}
    resetSyncBackoff();
    updateStatus();
  } catch (e) {
    console.error('Sync armoire:', e);
    await enq();
    showToast('Armoire sauvée local — sync au retour réseau', '');
    updateStatus();
    if (navigator.onLine) scheduleSyncRetry();
  }
}

async function flushSyncQueue() {
  if (isSyncing || !navigator.onLine) return;
  isSyncing = true;
  try {
    let items = [];
    try { items = await DB.all('queue'); } catch (e) {}
    if (!items.length) { isSyncing = false; return; }
    showToast('Synchronisation de ' + items.length + ' éléments…', '');

    // Séparer par type : les points partent en LOTS (batchUpsert = 1 requête pour 50 points).
    const pts = items.filter(it => !it.kind || it.kind === 'point');
    const autres = items.filter(it => it.kind === 'del' || it.kind === 'armoire');

    // — points groupés —
    const LOT = 50;
    let envoyes = 0;
    for (let i = 0; i < pts.length; i += LOT) {
      if (!navigator.onLine) break;
      const tranche = pts.slice(i, i + LOT);
      try {
        const res = await fetch(SCRIPT_URL, {
          method: 'POST', headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ action: 'batchUpsert', sheet: 'Points Lumineux',
            items: tranche.map(it => ({ id: it.pt.id, data: pointToData(it.pt) })) })
        });
        const r = await res.json();
        if (r.error) throw new Error(r.error);
        // succès du lot → on retire ces points de la file
        for (const it of tranche) { try { await DB.del('queue', it.id); } catch (e) {} }
        envoyes += tranche.length;
        showToast('Synchronisation… ' + envoyes + '/' + pts.length, '');
      } catch (e) {
        console.warn('Lot en échec, réessai plus tard :', e);
        break;   // on garde le reste en file pour le prochain passage
      }
    }

    // — armoires et suppressions : à l'unité (peu nombreuses) —
    for (const it of autres) {
      if (!navigator.onLine) break;
      try {
        if (it.kind === 'del') await sendDeleteToSheets(it.sheet, it.targetId);
        else if (it.kind === 'armoire') await syncArmoireToSheets(it.pt);
      } catch (e) { console.warn('Élément en échec :', e); }
    }
  } finally {
    isSyncing = false;                          // TOUJOURS libéré, même en cas d'erreur
  }
  uploadPendingPhotos();
  updateStatus();
}
window.addEventListener('online', () => { resetSyncBackoff(); flushSyncQueue(); });
