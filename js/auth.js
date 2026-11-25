/* ════════════════════════════════════════════════════════════════════════
   Audit EP — accès par code (un code à 4 chiffres par intervenant)
   Chargé APRÈS app.js (il utilise DB, SCRIPT_URL, currentScreen, showToast…).

   • authLogin()   : vérifie prénom + nom + code auprès du serveur et récupère un jeton.
                     Sans réseau, vérifie le code contre une empreinte gardée sur l'appareil
                     (créée lors d'une précédente connexion réussie avec réseau).
   • fetch         : toute requête vers SCRIPT_URL reçoit automatiquement le jeton.
   • session perdue (jeton expiré, intervenant désactivé, retour du réseau après une
     connexion hors-ligne) : une fenêtre redemande le code. Rien n'est perdu : les points
     et photos en attente restent en file et partent juste après.
   • Le jeton n'est gardé qu'en mémoire (fermer l'appli = se reconnecter).
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var _rawFetch = window.fetch.bind(window);        // fetch d'origine (sans jeton)
  var OFFLINE_MAX_FAILS = 5;                         // essais faux hors-ligne avant blocage
  var OFFLINE_LOCK_MS = 15 * 60 * 1000;              // durée du blocage hors-ligne
  var PBKDF2_ITER = 150000;

  var AUTH = { token: '', cle: '', nom: '', offline: false, snoozeUntil: 0 };
  window.AUTH = AUTH;

  /* ---------- utilitaires ---------- */
  // Même règle que le serveur (cleNom_) : mots normalisés, triés → l'ordre prénom/nom est indifférent.
  function authKey(prenom, nom) {
    return String((prenom || '') + ' ' + (nom || '')).split(/\s+/)
      .map(function (w) { return w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, ''); })
      .filter(Boolean).sort().join('-');
  }
  function bytesToHex(b) { return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }
  function hexToBytes(h) { var o = new Uint8Array(h.length / 2); for (var i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; }
  function randomHex(n) { var b = new Uint8Array(n); crypto.getRandomValues(b); return bytesToHex(b); }
  function canCrypto() { return !!(window.crypto && crypto.subtle && crypto.getRandomValues); }
  function pbkdf2Hex(secret, saltHex) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']).then(function (key) {
      return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: PBKDF2_ITER, hash: 'SHA-256' }, key, 256);
    }).then(function (bits) { return bytesToHex(new Uint8Array(bits)); });
  }
  async function readRec() {
    try { return (await DB.get('meta', 'auth')) || { k: 'auth', users: {} }; } catch (e) { return { k: 'auth', users: {} }; }
  }
  async function writeRec(rec) { try { await DB.put('meta', rec); } catch (e) { console.warn('auth rec', e); } }

  /* ---------- connexion ---------- */
  // Renvoie { ok:true, nom, mode:'online'|'offline' } ou { ok:false, msg }
  async function authLogin(prenom, nom, code) {
    var cle = authKey(prenom, nom);
    var nomSaisi = (String(prenom || '').trim() + ' ' + String(nom || '').trim()).trim();
    code = String(code || '').trim();
    if (!cle) return { ok: false, msg: 'Saisissez votre prénom et votre nom' };
    if (!/^\d{4}$/.test(code)) return { ok: false, msg: 'Le code comporte 4 chiffres' };

    var res = null;
    if (navigator.onLine) {
      try {
        var ctl = new AbortController();
        var tmo = setTimeout(function () { ctl.abort(); }, 12000);
        var r = await _rawFetch(SCRIPT_URL, {
          method: 'POST', headers: { 'Content-Type': 'text/plain' }, signal: ctl.signal,
          body: JSON.stringify({ action: 'login', prenom: prenom, nom: nom, code: code })
        });
        clearTimeout(tmo);
        res = await r.json();
      } catch (e) { res = null; }            // réseau injoignable → vérification locale
    }

    if (res) {
      if (res.error) {
        if (/Unknown action/i.test(res.error)) return { ok: false, msg: 'Le serveur n’est pas à jour (script sans code d’accès)' };
        return { ok: false, msg: res.error };
      }
      if (!res.token) return { ok: false, msg: 'Réponse inattendue du serveur' };
      AUTH.token = res.token; AUTH.cle = cle; AUTH.nom = res.nom || nomSaisi; AUTH.offline = false;
      await rememberLocally(cle, AUTH.nom, code);
      return { ok: true, nom: AUTH.nom, mode: 'online' };
    }
    return offlineLogin(cle, code, nomSaisi);
  }

  // Empreinte locale (PBKDF2 salé) : permet de rouvrir l'appli sans réseau.
  async function rememberLocally(cle, nom, code) {
    if (!canCrypto()) return;
    try {
      var rec = await readRec();
      var salt = randomHex(16);
      rec.users[cle] = { nom: nom, salt: salt, hash: await pbkdf2Hex(cle + '|' + code, salt), fails: 0, lockUntil: 0 };
      await writeRec(rec);
    } catch (e) { console.warn('rememberLocally', e); }
  }

  async function offlineLogin(cle, code, nomSaisi) {
    if (!canCrypto()) return { ok: false, msg: 'Réseau indisponible — connexion impossible' };
    var rec = await readRec();
    var u = rec.users[cle];
    if (!u) return { ok: false, msg: 'Hors-ligne : connectez-vous au moins une fois avec du réseau sur cet appareil' };
    if (u.lockUntil && Date.now() < u.lockUntil) {
      return { ok: false, msg: 'Trop d’essais — réessayez dans ' + Math.ceil((u.lockUntil - Date.now()) / 60000) + ' min' };
    }
    var h = await pbkdf2Hex(cle + '|' + code, u.salt);
    if (h !== u.hash) {
      u.fails = (u.fails || 0) + 1;
      if (u.fails >= OFFLINE_MAX_FAILS) { u.fails = 0; u.lockUntil = Date.now() + OFFLINE_LOCK_MS; }
      await writeRec(rec);
      return { ok: false, msg: 'Code incorrect' };
    }
    u.fails = 0; u.lockUntil = 0; await writeRec(rec);
    AUTH.token = ''; AUTH.cle = cle; AUTH.nom = u.nom || nomSaisi; AUTH.offline = true;
    return { ok: true, nom: AUTH.nom, mode: 'offline' };
  }

  function authLogout() { AUTH.token = ''; AUTH.cle = ''; AUTH.nom = ''; AUTH.offline = false; hideReauth(); }

  /* ---------- jeton ajouté à chaque requête vers le script ---------- */
  function isScript(url) { return typeof SCRIPT_URL === 'string' && url.indexOf(SCRIPT_URL) === 0; }

  function watch(res, usedToken) {
    try {
      var j = res.json.bind(res);
      res.json = function () {
        return j().then(function (d) {
          if (d && typeof d.error === 'string' && d.error.indexOf('AUTH_') === 0) authLost(d.error, usedToken);
          return d;
        });
      };
    } catch (e) {}
    return res;
  }

  window.fetch = function (input, init) {
    if (typeof input !== 'string' || !isScript(input)) return _rawFetch(input, init);
    var u = input, i = init, used = AUTH.token;
    if (AUTH.token) {
      var method = (init && init.method) ? String(init.method).toUpperCase() : 'GET';
      if (method === 'GET') {
        u = input + (input.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(AUTH.token);
      } else if (init && typeof init.body === 'string' && init.body.charAt(0) === '{') {
        i = Object.assign({}, init, {
          body: '{"token":' + JSON.stringify(AUTH.token) + (init.body.length > 2 ? ',' : '') + init.body.slice(1)
        });
      }
    }
    return _rawFetch(u, i).then(function (res) { return watch(res, used); });
  };

  /* ---------- session perdue : redemande le code ---------- */
  function authLost(code, usedToken) {
    if (!AUTH.cle) return;                                                   // pas de session ouverte
    if (usedToken !== undefined && usedToken !== AUTH.token) return;       // réponse tardive d'une ancienne session
    if (typeof currentScreen !== 'undefined' && currentScreen === 'login') return;
    AUTH.token = '';
    if (Date.now() < AUTH.snoozeUntil) return;                              // « Plus tard » choisi récemment
    showReauth(code);
  }
  function showReauth(code) {
    var el = document.getElementById('reauth'); if (!el) return;
    var msg = document.getElementById('reauth-msg');
    var txt = {
      AUTH_EXPIRED: 'Votre session a expiré.',
      AUTH_REVOKED: 'Votre accès a été modifié (code changé ou compte désactivé).',
      AUTH_REQUIRED: 'Connexion au serveur requise.'
    }[code] || 'Connexion au serveur requise.';
    if (msg) msg.textContent = txt + ' Saisissez votre code pour synchroniser. Vos données restent enregistrées sur l’appareil.';
    el.classList.add('open');
    var inp = document.getElementById('reauth-code'); if (inp) { inp.value = ''; setTimeout(function () { inp.focus(); }, 50); }
  }
  function hideReauth() { var el = document.getElementById('reauth'); if (el) el.classList.remove('open'); }

  async function reauthSubmit() {
    var inp = document.getElementById('reauth-code');
    var btn = document.getElementById('reauth-go');
    var err = document.getElementById('reauth-err');
    if (err) err.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = 'Vérification…'; }
    try {
      var r = await authLogin(AUTH.nom, '', inp ? inp.value : '');
      if (!r.ok) { if (err) err.textContent = r.msg; if (inp) { inp.value = ''; inp.focus(); } return; }
      if (r.mode === 'offline') { if (err) err.textContent = 'Réseau indisponible — réessayez plus tard'; return; }
      hideReauth();
      if (typeof showToast === 'function') showToast('Session rétablie ✓', 'success');
      if (typeof flushSyncQueue === 'function') flushSyncQueue();           // envoie ce qui attendait
      if (typeof uploadPendingPhotos === 'function') uploadPendingPhotos();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Valider'; }
    }
  }
  function reauthLater() { AUTH.snoozeUntil = Date.now() + 5 * 60 * 1000; hideReauth(); }

  window.authLogin = authLogin;
  window.authLogout = authLogout;
  window.authKey = authKey;
  window.reauthSubmit = reauthSubmit;
  window.reauthLater = reauthLater;
})();
