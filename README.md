# Simulateur LiDAR France — prototype iTowns

Prototype web open source centré sur **iTowns** pour explorer les données IGN en 2D/3D et construire progressivement un simulateur de drone fondé sur le LiDAR HD français.

## État actuel

Le dépôt fournit un visualiseur IGN utilisable :

- recherche d’adresse via la Géoplateforme ;
- vues Plan IGN, orthophoto IGN et iTowns avancée ;
- navigation 2D verticale ou 3D légère ;
- sélection rectangulaire d’une zone ;
- recherche des dalles LiDAR HD IGN ;
- détection des fichiers COPC ;
- téléchargement local asynchrone avec progression et annulation ;
- service HTTP local compatible avec les requêtes `Range` utilisées par COPC ;
- diagnostic du chargement : en-tête LAS, métadonnées, octree, caméra et nombre de points réellement rendus.

Ce n’est pas encore un simulateur de drone. Le jalon actuel consiste à rendre l’accès COPC fiable et observable avant d’ajouter le MNT, les filtres et les traitements de reconstruction.

## Parcours LiDAR recommandé

1. Rechercher une commune ou une adresse.
2. Sélectionner une zone rectangulaire.
3. Rechercher les dalles LiDAR IGN.
4. Sur une dalle COPC, cliquer sur **Télécharger et afficher**.
5. Suivre le téléchargement et le diagnostic COPC.
6. Considérer le chargement réussi uniquement lorsque l’interface indique un nombre de points visible supérieur à zéro.

Le bouton **Essai direct** reste expérimental : il dépend du CORS et du support des requêtes `Range` du serveur distant.

Les dalles LAZ non-COPC sont détectées mais ne sont pas encore affichées. Elles devront être converties en COPC, par exemple avec PDAL, avant leur utilisation dans iTowns.

## Installation Windows 11

Prérequis : Git, Node.js 20+, Python 3.11+.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows\install.ps1
.\scripts\windows\run.ps1
```

Puis ouvrir `http://localhost:5173`.

## Installation manuelle

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r server\requirements.txt
npm install --prefix web
```

Dans deux terminaux :

```powershell
.\.venv\Scripts\python.exe -m uvicorn server.app:app --reload --port 8000
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

## Architecture

```text
web/                 interface iTowns, sélection et diagnostic COPC
server/              proxy IGN, téléchargements asynchrones et fichiers Range HTTP
tests/               tests de l’API locale et du service de fichiers
configs/             catalogue logique des couches IGN
data/                fichiers locaux ignorés par Git
scripts/windows/     installation et lancement Windows
```

## Roadmap

1. Chargement COPC fiable et observable.
2. Ajout du MNT / terrain IGN réel.
3. Filtres LiDAR : classes, altitude, densité et taille des points.
4. Réintégration du pipeline de reconstruction et des exports GLB/Godot.
5. Caméra type drone et manette.
6. Reconstruction bâtiments et arbres.
7. Physique simplifiée et collisions.
8. Passerelle PX4/MAVLink.

## Limites

Ce dépôt est un visualiseur géospatial expérimental. Il ne garantit ni l’actualité du terrain réel ni la sécurité d’un vol.

Licence : MIT.
