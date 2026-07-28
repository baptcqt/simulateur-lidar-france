# Simulateur LiDAR France — prototype iTowns

Prototype web open source centré sur **iTowns** pour explorer les données IGN en 2D/3D et construire progressivement un simulateur fondé sur le LiDAR HD français.

## Parcours actuel

1. Rechercher une commune ou une adresse.
2. Sélectionner une petite zone sur la carte IGN.
3. L’application recherche automatiquement la dalle COPC correspondant au centre de la sélection.
4. Cliquer sur **Afficher le LiDAR**.
5. Le fichier est téléchargé ou repris depuis le cache local.
6. Une vue COPC native iTowns remplace temporairement la carte et cadre automatiquement le nuage de points.
7. Cliquer sur **Revenir à la carte** pour retrouver exactement la carte et la position précédentes.

L’interface ne présente pas les détails techniques du cache, des requêtes HTTP partielles ou du décodeur. Ces opérations sont automatiques.

## Réutiliser une dalle téléchargée

Le bloc repliable **Dalles déjà téléchargées** permet de travailler sans nouvelle recherche IGN :

- la dalle `.copc.laz` la plus récente de `data/lidar` est sélectionnée automatiquement ;
- **Afficher la dalle enregistrée** l’ouvre directement dans la vue native iTowns ;
- **Choisir un fichier…** ouvre la boîte de dialogue Windows, copie le fichier choisi dans `data/lidar`, puis l’affiche ;
- **Ouvrir le dossier** ouvre `data/lidar` dans l’Explorateur Windows.

Seuls les fichiers `.copc.laz` sont acceptés, car iTowns doit pouvoir lire l’octree et les portions compressées du fichier.

## Architecture d’affichage

Deux vues iTowns partagent le même espace visuel :

- une `GlobeView` conserve la carte IGN, la recherche et la sélection ;
- une `View` avec `PlanarControls` et `CopcLayer` ouvre le fichier COPC dans son système de coordonnées natif.

Les points LAZ sont décompressés dans le navigateur avec **laz-perf WebAssembly**. Le fichier `laz-perf.wasm` est copié dans `web/public/laz-perf` pendant l’installation et servi localement. Le rendu LiDAR ne dépend donc plus d’un CDN externe.

## Installation Windows 11

Prérequis : Git, Node.js 20+ et Python 3.11+.

```powershell
git clone <URL_DU_DEPOT>
cd simulateur-lidar-france
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows\install.ps1
.\scripts\windows\run.ps1
```

Le lanceur :

- vérifie les dépendances ;
- prépare le décodeur LiDAR local ;
- ferme les anciennes instances qui occupent les ports 8000 et 5173 ;
- démarre l’API et Vite ;
- attend que l’API, l’interface et le fichier WASM répondent avant d’ouvrir le navigateur.

## Installation manuelle

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r server\requirements.txt
npm install --prefix web
node web\scripts\copy-laz-perf.mjs
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

La CI exécute les tests serveur et le build Vite sur chaque push et pull request.

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
web/                 carte IGN, vue COPC native et sélection de fichiers locaux
web/scripts/         préparation des ressources WebAssembly
server/              proxy IGN, cache COPC, import local et service Range HTTP
tests/               tests de l’API locale
configs/             catalogue logique des couches IGN
data/lidar/          dalles COPC locales ignorées par Git
scripts/windows/     installation et lancement Windows
```

## Roadmap

1. Valider l’affichage COPC natif sur les dalles IGN.
2. Ajouter le MNT / terrain IGN réel.
3. Ajouter les filtres LiDAR : classes, altitude, densité et taille des points.
4. Réintégrer le pipeline de reconstruction et les exports GLB/Godot.
5. Ajouter une caméra type drone et la manette.
6. Ajouter les bâtiments, arbres, collisions et physique simplifiée.
7. Ajouter une passerelle PX4/MAVLink.

## Limites

Ce dépôt est un visualiseur géospatial expérimental. Il ne garantit ni l’actualité du terrain réel ni la sécurité d’un vol.

Licence : MIT.
