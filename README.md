# Simulateur LiDAR France — prototype iTowns + PDAL

Prototype web open source centré sur **iTowns** pour explorer les données IGN et construire progressivement un simulateur 3D simplifié fondé sur le LiDAR HD français.

Le rendu final visé n’est pas photoréaliste : l’orthophoto reste une aide de contrôle, mais la scène de simulation doit être générée depuis le LiDAR et des couches sémantiques simplifiées.

## Parcours actuel

1. Rechercher une commune ou une adresse.
2. Sélectionner une petite zone sur la carte IGN.
3. L’application recherche automatiquement la dalle COPC correspondant au centre de la sélection.
4. Cliquer sur **Afficher le LiDAR**.
5. Le fichier est téléchargé ou repris depuis le cache local.
6. Le serveur lance **PDAL** pour cropper la sélection, nettoyer les classes utiles et produire un COPC traité dans `data/processed`.
7. Le serveur extrait des volumes bâtiment **uniquement depuis les points LiDAR classés bâtiment**.
8. `lidar.html` affiche la zone traitée dans iTowns, avec le nuage LiDAR et les volumes générés.
9. Cliquer sur **Revenir à la carte** pour retrouver la carte.

La dalle brute complète n’est donc plus le rendu principal du bouton **Afficher le LiDAR** : elle sert de source au traitement local.

## Réutiliser une dalle téléchargée

Le bloc repliable **Dalles déjà téléchargées** permet de travailler sans nouvelle recherche IGN :

- la dalle `.copc.laz` la plus récente de `data/lidar` est sélectionnée automatiquement ;
- **Afficher la dalle enregistrée** l’ouvre directement dans la vue 3D brute ;
- **Choisir un fichier…** ouvre la boîte de dialogue Windows, copie le fichier choisi dans `data/lidar`, puis l’affiche ;
- **Ouvrir le dossier** ouvre `data/lidar` dans l’Explorateur Windows.

Seuls les fichiers `.copc.laz` sont acceptés, car iTowns doit pouvoir lire l’octree et les portions compressées du fichier.

## Pipeline PDAL

Le traitement local est exposé par l’API :

```text
POST /lidar/processes
GET  /lidar/processes/{job_id}
GET  /lidar/pdal/status
```

Entrée :

```json
{
  "path": "/files/lidar/dalle.copc.laz",
  "bbox": { "minLon": -4.7, "minLat": 48.3, "maxLon": -4.69, "maxLat": 48.31 },
  "profile": "balanced"
}
```

Sorties :

```text
data/processed/<hash>/selection.copc.laz
data/processed/<hash>/buildings.json
data/processed/<hash>/manifest.json
```

Profils disponibles :

- `fluid` : décimation forte pour tests rapides ;
- `balanced` : profil par défaut ;
- `detailed` : plus de points et plus de volumes, plus coûteux.

Les volumes bâtiment sont approximatifs : ils sont calculés depuis les points LiDAR de classification `6` et un niveau de sol local déduit des points de classification `2`. **BD TOPO n’est pas utilisée pour ces volumes.**

## Architecture d’affichage

La carte de sélection et la vue de travail sont séparées :

- `index.html` contient la `GlobeView` de recherche et de sélection ;
- `lidar.html` contient une `GlobeView` dédiée au terrain 3D ;
- la vue terrain combine le MNT haute résolution, une `CopcLayer` cropée/nettoyée, et les volumes bâtiment LiDAR ;
- le `CopcLayer` est reprojeté vers le repère géocentrique de la `GlobeView` ;
- les points sont colorés par classification LAS pour distinguer sol, végétation, bâtiments, eau et voirie.

Les points LAZ sont décompressés dans le navigateur avec **laz-perf WebAssembly**. Le fichier `laz-perf.wasm` est copié dans `web/public/laz-perf` pendant l’installation et servi localement. Un worker Vite local utilise le `LASLoader` officiel d’iTowns afin de conserver une URL de worker stable.

## Installation Windows 11

Prérequis : Git, Node.js 20+, Python 3.11+ et **PDAL accessible dans le PATH**.

```powershell
git clone <URL_DU_DEPOT>
cd simulateur-lidar-france
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows\install.ps1
.\scripts\windows\run.ps1
```

Le lanceur :

- vérifie les dépendances ;
- indique si `pdal` est disponible ;
- prépare le décodeur LiDAR local ;
- ferme les anciennes instances qui occupent les ports 8000 et 5173 ;
- démarre l’API et Vite ;
- attend que l’API, l’interface, le fichier WASM et la passerelle PDAL répondent avant d’ouvrir le navigateur.

Si PDAL est absent, l’interface démarre encore, mais le crop/nettoyage échoue avec un message explicite.

## Installation manuelle

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r server\requirements.txt
npm install --prefix web
node web\scripts\copy-laz-perf.mjs
pdal --version
```

Dans deux terminaux :

```powershell
.\.venv\Scripts\python.exe -m uvicorn server.main:app --reload --port 8000
npm run dev --prefix web
```

## Tests

```powershell
python -m pip install pytest httpx
python -m pytest -q
npm run build --prefix web
```

La CI exécute les tests serveur et le build Vite sur chaque push et pull request. Les tests ne nécessitent pas l’installation réelle de PDAL : les pipelines et la passerelle sont validés sans traiter de dalle lourde.

## Configuration

`web/.env.local` est créé depuis `web/.env.example` pendant l’installation.

```env
VITE_IGN_WMTS_URL=https://data.geopf.fr/wmts
VITE_IGN_ORTHO_LAYER=ORTHOIMAGERY.ORTHOPHOTOS
VITE_IGN_TOPO_LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2
VITE_API_URL=http://127.0.0.1:8000
```

## Structure

```text
web/                 carte IGN, vue terrain 3D et sélection de fichiers locaux
web/scripts/         préparation et vérification des ressources WebAssembly
server/              proxy IGN, cache COPC, import local, PDAL et service Range HTTP
tests/               tests de l’API locale
configs/             catalogue logique des couches IGN
data/lidar/          dalles COPC locales ignorées par Git
data/processed/      sorties PDAL ignorées par Git
scripts/windows/     installation et lancement Windows
```

## Roadmap

1. **Terminé :** lecture, décompression et rendu des dalles COPC IGN.
2. **Terminé :** vue iTowns dédiée avec MNT, orthophoto de contrôle et LiDAR géoréférencé.
3. **En cours :** PDAL pour crop, nettoyage de classes et profils de densité.
4. **En cours :** volumes bâtiment générés depuis le LiDAR seul, sans BD TOPO.
5. Ajouter végétation simplifiée, eau, routes et surfaces artificielles sans phototextures.
6. Préparer les exports GLB/Godot avec collisions simplifiées.
7. Ajouter une caméra type drone et la manette.
8. Ajouter une passerelle PX4/MAVLink.

## Limites

Ce dépôt est un visualiseur/générateur géospatial expérimental. Les volumes bâtiment LiDAR sont des approximations utiles au simulateur, pas une maquette cadastrale. Le projet ne garantit ni l’actualité du terrain réel ni la sécurité d’un vol.

Licence : MIT.
