# Simulateur LiDAR France — prototype iTowns

Prototype web open source centré sur **iTowns** pour explorer les données IGN en 2D/3D avant d'ajouter une couche de simulation de drone.

## État actuel

Le dépôt contient maintenant un premier visualiseur IGN utilisable :

- recherche d'adresse via le service de géocodage de la Géoplateforme ;
- déplacement automatique de la caméra vers le premier résultat ;
- démarrage en **BD topo / Plan IGN**, en vue 2D verticale ;
- choix entre trois vues : **BD topo / Plan IGN**, **Satellite IGN** et **Vue iTowns avancée** ;
- bascule d'angle entre **2D verticale** et **3D légère** ;
- interface simplifiée sans champs techniques longitude/latitude/distance ;
- sélection rectangulaire visible, au-dessus de la carte, avec blocage des mouvements pendant la sélection ;
- recherche de dalles LiDAR HD IGN sur une emprise sélectionnée ;
- chargement expérimental de dalles **COPC** via iTowns `CopcSource` / `CopcLayer` ;
- serveur FastAPI local pour le géocodage, le cache et le téléchargement local des COPC ;
- aucune donnée OpenStreetMap.

Ce n'est pas encore un simulateur de drone. C'est le socle de visualisation sur lequel ajouter le MNT, le LiDAR HD, les filtres et la caméra drone.

## Flux LiDAR actuel

1. Rechercher une commune ou une adresse.
2. Passer en **Vue iTowns avancée**.
3. Cliquer sur **Sélectionner une zone**.
4. Tracer un rectangle sur la carte. La carte ne doit pas bouger pendant ce geste.
5. Cliquer sur **Rechercher les dalles LiDAR IGN**.
6. Si une dalle est identifiée comme **COPC**, utiliser :
   - **Charger direct** pour tenter le chargement depuis l'URL distante ;
   - **Cache local** pour télécharger la dalle dans `data/lidar/`, puis la charger depuis `localhost`.

Les dalles LAZ non-COPC sont détectées mais ne sont pas encore affichées dans iTowns. Elles devront passer par une conversion COPC ou un autre pipeline.

## Objectif du MVP

- ouvrir une zone en France depuis une adresse ;
- afficher un globe/terrain iTowns ;
- basculer entre Plan IGN, orthophoto IGN et vue iTowns avancée ;
- sélectionner une zone de travail ;
- trouver les dalles LiDAR IGN associées ;
- charger une dalle COPC dans iTowns ;
- préparer l'ajout du MNT, des filtres LiDAR et de CoSIA.

## Installation Windows 11

Prérequis : Git, Node.js 20+, Python 3.11+.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows\install.ps1
.\scripts\windows\run.ps1
```

Puis ouvrir `http://localhost:5173`.

## Configuration

`web/.env.local` est créé automatiquement depuis `web/.env.example` pendant l'installation.

Valeurs par défaut :

```env
VITE_IGN_WMTS_URL=https://data.geopf.fr/wmts
VITE_IGN_ORTHO_LAYER=ORTHOIMAGERY.ORTHOPHOTOS
VITE_IGN_TOPO_LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2
VITE_API_URL=http://127.0.0.1:8000
```

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

## Architecture

```text
web/                 interface iTowns, vues de base, sélection et COPC
server/              API locale, proxy géocodage, recherche WFS LiDAR, cache
configs/             catalogue logique des couches IGN
data/                fichiers locaux ignorés par Git
scripts/windows/     installation et lancement Surface Pro 9
```

## Roadmap

1. Recherche adresse + vues Plan IGN / Satellite / iTowns avancée.
2. Sélection rectangulaire stable et recherche de dalles LiDAR.
3. Chargement COPC fiable, avec fallback cache local.
4. Ajout MNT / terrain IGN réel.
5. Filtres LiDAR : classes, altitude, densité, taille de point.
6. Caméra type drone et manette.
7. Reconstruction bâtiments/arbres.
8. Physique simplifiée.
9. Passerelle PX4/MAVLink.

## Limites

Ce dépôt est un visualiseur géospatial expérimental. Il ne garantit ni l'actualité du terrain réel ni la sécurité d'un vol.

Licence : MIT.
