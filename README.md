# Simulateur LiDAR France — prototype iTowns + PDAL

Prototype web open source centré sur **iTowns** et **PDAL** pour explorer les données IGN en 2D/3D et construire progressivement un simulateur simplifié fondé sur le LiDAR HD français.

## Parcours actuel

1. Rechercher une commune ou une adresse.
2. Sélectionner une petite zone sur la carte IGN.
3. L’application recherche automatiquement la dalle COPC correspondant au centre de la sélection.
4. Cliquer sur **Afficher le LiDAR**.
5. Le fichier est téléchargé ou repris depuis le cache local.
6. Le serveur lance PDAL pour cropper exactement la sélection, nettoyer les classes utiles et produire un nouveau `selection.copc.laz`.
7. Les points LiDAR classés bâtiment génèrent des premiers volumes simplifiés sans BD TOPO.
8. Une vue 3D iTowns affiche la sélection traitée et les volumes LiDAR.
9. Cliquer sur **Revenir à la carte** pour retrouver la carte et la position précédentes.

L’interface ne présente pas les détails techniques du cache, des requêtes HTTP partielles, du décodeur ou du pipeline PDAL. Ces opérations sont automatiques.

## Diagnostic et logs

Le projet écrit des logs locaux dans `logs/`. Ce dossier est présent dans le dépôt grâce à `logs/.gitkeep`, mais les vrais fichiers `.log` restent ignorés par Git.

Fichiers principaux :

- `logs/launcher.log` : lancement Windows, PATH, PDAL détecté, vérifications de ports et endpoints ;
- `logs/api-console.log` : console FastAPI/uvicorn ;
- `logs/web-console.log` : console Vite ;
- `logs/simulateur.log` : événements serveur globaux ;
- `logs/requests.log` : toutes les requêtes HTTP reçues par l’API ;
- `logs/pdal.log` : détection PDAL, pipelines, code retour, stdout/stderr ;
- `logs/frontend.log` : erreurs navigateur, fetch, pages chargées.

Endpoints utiles quand il y a un bug :

```text
http://127.0.0.1:8000/diagnostics/status
http://127.0.0.1:8000/diagnostics/logs.zip
http://127.0.0.1:8000/lidar/pdal/status
```

En cas de problème, envoyer directement le fichier ZIP produit par `/diagnostics/logs.zip`. Il regroupe les logs, les scripts runtime générés et un snapshot de l’environnement serveur.

## Installer PDAL sous Windows

PDAL n’est pas un paquet Python classique sous Windows. Le projet installe donc un environnement local Conda Forge dans `.pdal-env`.

```powershell
.\scripts\windows\install-pdal.ps1
```

Le script :

- réutilise `mamba`, `conda` ou `micromamba` si disponible ;
- installe Miniforge3 via `winget` si aucun gestionnaire Conda Forge n’est trouvé ;
- crée `.pdal-env` dans le dépôt ;
- installe `pdal` depuis `conda-forge` ;
- ne publie rien dans GitHub.

Ensuite :

```powershell
.\scripts\windows\run.ps1
```

Le lanceur ajoute automatiquement `.pdal-env\Library\bin` au `PATH` de l’API et vérifie que le serveur voit réellement PDAL.

## Réutiliser une dalle téléchargée

Le bloc repliable **Dalles déjà téléchargées** permet de travailler sans nouvelle recherche IGN tout en conservant le même flux PDAL :

- la dalle `.copc.laz` la plus récente de `data/lidar` est sélectionnée automatiquement ;
- **Placer cette dalle sur la carte** lit seulement l’emprise COPC, puis recentre la carte IGN sur cette dalle ;
- le fond de carte reste celui choisi par l’utilisateur, BD topo / Plan IGN ou satellite ;
- l’utilisateur trace ensuite une zone sur la carte comme d’habitude ;
- **Afficher le LiDAR** utilise la dalle locale déjà présente, puis lance le crop/nettoyage PDAL sur la sélection ;
- **Choisir un fichier…** copie un fichier `.copc.laz` externe dans `data/lidar`, le place sur la carte, puis le rend disponible pour le même flux ;
- **Ouvrir le dossier** ouvre `data/lidar` dans l’Explorateur Windows.

Seuls les fichiers `.copc.laz` sont acceptés, car iTowns doit pouvoir lire l’octree et les portions compressées du fichier.

## Architecture d’affichage

La carte de sélection et la vue de travail sont séparées :

- `index.html` contient la `GlobeView` de recherche et de sélection ;
- `lidar.html` contient une `GlobeView` dédiée au terrain 3D ;
- le COPC brut est traité par PDAL avant affichage ;
- la vue terrain peut conserver l’orthophoto IGN comme calque de contrôle, mais le rendu cible du simulateur reste simplifié ;
- les volumes bâtiment sont dérivés uniquement des points LiDAR classés bâtiment ;
- le `CopcLayer` est reprojeté vers le repère géocentrique de la `GlobeView`, conformément à l’exemple officiel iTowns ;
- les points sont colorés par classification LAS pour distinguer sol, végétation, bâtiments, eau et voirie.

Les points LAZ sont décompressés dans le navigateur avec **laz-perf WebAssembly**. Le fichier `laz-perf.wasm` est copié dans `web/public/laz-perf` pendant l’installation et servi localement. Un worker Vite local utilise le `LASLoader` officiel d’iTowns afin de conserver une URL de worker stable.

## Installation Windows 11

Prérequis : Git, Node.js 20+, Python 3.11+ et winget ou Miniforge/Conda.

```powershell
git clone <URL_DU_DEPOT>
cd simulateur-lidar-france
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows\install.ps1
.\scripts\windows\install-pdal.ps1
.\scripts\windows\run.ps1
```

Le lanceur :

- vérifie les dépendances ;
- prépare le décodeur LiDAR local ;
- ferme les anciennes instances qui occupent les ports 8000 et 5173 ;
- démarre l’API et Vite ;
- écrit les logs dans `logs/` ;
- attend que l’API, l’interface, PDAL et le fichier WASM répondent avant d’ouvrir le navigateur.

## Installation manuelle

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r server\requirements.txt
npm install --prefix web
node web\scripts\copy-laz-perf.mjs
```

PDAL doit aussi être accessible dans le `PATH` de l’API pour activer le crop et les volumes LiDAR.

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
web/                 carte IGN, vue terrain 3D et sélection de fichiers locaux
web/scripts/         préparation et vérification des ressources WebAssembly
server/              proxy IGN, cache COPC, import local, PDAL et service Range HTTP
tests/               tests de l’API locale
configs/             catalogue logique des couches IGN
data/lidar/          dalles COPC locales ignorées par Git
data/processed/      zones traitées PDAL ignorées par Git
logs/                logs locaux ignorés par Git, sauf .gitkeep
scripts/windows/     installation et lancement Windows
```

## Roadmap

1. **Terminé :** lecture, décompression et rendu des dalles COPC IGN.
2. **En cours :** crop PDAL réel, nettoyage, volumes bâtiments LiDAR et rendu simulation simplifiée.
3. Améliorer le monde simplifié : sol maillé, eau, végétation, routes et collisions.
4. Réintégrer les exports GLB/Godot.
5. Ajouter une caméra type drone et la manette.
6. Ajouter une passerelle PX4/MAVLink.

## Limites

Ce dépôt est un visualiseur géospatial expérimental. Il ne garantit ni l’actualité du terrain réel ni la sécurité d’un vol.

Licence : MIT.
