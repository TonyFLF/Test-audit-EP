# Audit EP – Éclairage public, terrain connecté

Application web (PWA) d'audit d'éclairage public : carte (Leaflet), points lumineux et armoires,
photos, mode hors-ligne, synchronisation avec une feuille Google Sheets.

Reconstruite à partir d'une copie enregistrée de la page. Le code de l'appli (`js/app.js`, `css/style.css`)
est celui d'origine, simplement sorti de la page HTML pour pouvoir être modifié fichier par fichier.

## Structure

| Fichier | Rôle |
|---|---|
| `index.html` | Écrans et structure de la page |
| `css/style.css` | Apparence |
| `js/app.js` | Toute la logique (carte, formulaires, photos, hors-ligne, synchronisation) |
| `sw.js` | Service worker : appli utilisable hors-ligne + fonds de carte téléchargés |
| `manifest.json` | Installation sur l'écran d'accueil |
| `icons/` | Icônes (recréées : l'original n'était pas dans l'archive, remplace-les si tu as les tiens) |
| `lib/` | Leaflet, MarkerCluster, proj4 (copiés en local, aucun CDN) |

## ⚠️ Point important : la base de données (Google Sheet)

Les données (points, armoires, photos, chantiers) sont synchronisées avec un **script Google Apps Script**
relié à une feuille Google Sheets. Son adresse est dans `js/app.js`, constante `SCRIPT_URL`
(cherche ce mot avec Ctrl + F).

- Le code de ce script **n'est pas dans ce dépôt** : il vit dans le compte Google de la personne qui l'a créé.
- Tant que `SCRIPT_URL` pointe vers ce script, l'appli lit et écrit dans **cette feuille-là**.
- Pour en être vraiment propriétaire, il faut que **toi** tu possèdes ce Sheet et ce script
  (ouvre la feuille → *Extensions → Apps Script* : si tu y accèdes, c'est le tien).
  Sinon, il faut recréer un script sur ton compte (je peux le faire si tu me donnes la structure du Sheet),
  puis remplacer `SCRIPT_URL`.

## Mettre en ligne (GitHub Pages)

1. https://github.com/new → nom du dépôt : `AUDIT-PEEEPS`, **Public**, ne coche rien d'autre → *Create repository*.
2. **uploading an existing file** → glisse **le contenu** du dossier (pas le ZIP) → *Commit changes*.
3. **Settings → Pages** → *Deploy from a branch* → `main` / `/ (root)` → *Save*.
4. Après ~1 minute : `https://TON-PSEUDO.github.io/AUDIT-PEEEPS/`.

`index.html` doit être à la racine du dépôt.

## Après une modification

- Le service worker sert toujours la version la plus récente quand il y a du réseau.
  Pour forcer la mise à jour du cache hors-ligne, change `VERSION` dans `sw.js` (`'v1'` → `'v2'`).
- Les données saisies restent dans le navigateur de chaque appareil (IndexedDB) tant qu'elles ne sont pas synchronisées.
  **Ne vide pas les données du site** sur un téléphone qui a des points non synchronisés.

## Limites connues

- Les fonds de carte (OpenStreetMap, Esri, IGN) et les polices Google viennent d'internet ; hors-ligne, seules
  les zones préchargées (bouton de téléchargement de la carte) s'affichent.
- Les photos déjà envoyées sont relues depuis Google Drive : elles dépendent des droits du script d'origine.
