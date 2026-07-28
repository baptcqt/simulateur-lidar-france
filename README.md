# Simulateur LiDAR France — prototype iTowns

Prototype web open source centré sur **iTowns** pour explorer les données IGN en 2D/3D avant d'ajouter une couche de simulation de drone.

## État actuel

Le dépôt contient maintenant un premier visualiseur IGN avec un début de mode iTowns avancé :

- recherche d'adresse via le service de géocodage de la Géoplateforme ;
- déplacement automatique de la caméra vers le premier résultat ;
- démarrage en **BD topo / Plan IGN**, en vue 2D verticale ;
- choix entre **BD topo / Plan IGN**, **Satellite IGN** et **Vue iTowns avancée** ;
- bascule d'angle entre **2D verticale du dessus** et **3D légère** ;
- une seule couche WMTS active à la fois pour limiter la charge réseau/GPU ;
- mode iTowns avancé avec sélection rectangulaire d'emprise ;
- recherche des dalles **LiDAR HD IGN** qui intersectent l'emprise sélectionnée via WFS ;
- chargement expérimental d'une dalle **COPC LAZ** par URL dans `CopcSource` + `CopcLayer` ;
- serveur FastAPI local qui sert de proxy de géocodage, de recherche LiDAR et préparera le cache ;
- aucune donnée OpenStreetMap.

Ce n'est pas encore un simulateur de drone. C'est le socle de visualisation sur lequel ajouter le MNT, le LiDAR HD, les filtres et la caméra drone.

## Vue iTowns avancée

La vue iTowns avancée n'est plus un fond vide. Elle utilise le moteur iTowns avec les briques natives suivantes :

```text
GlobeView
ColorLayer / WMTSSource
CopcSource
CopcLayer
PointCloudLayer
sélection d'emprise côté navigateur
proxy WFS côté serveur
```

Flux prévu :

```text
sélection rectangle sur la carte
        ↓
conversion en bbox EPSG:4326
        ↓
requête WFS Géoplateforme sur IGNF_NUAGES-DE-POINTS-LIDAR-HD:dalle
        ↓
liste des dalles disponibles
        ↓
chargement expérimental d'une URL COPC dans iTowns
```

Les dalles LiDAR HD peuvent être lourdes. Le chargement automatique complet sera ajouté progressivement avec garde-fous de taille, cache local et annulation.

## Objectif du MVP

- ouvrir une zone en France depuis une adresse ou des coordonnées ;
- afficher un globe/terrain iTowns ;
- basculer entre Plan IGN, orthophoto IGN et vue iTowns avancée ;
- sélectionner une emprise rectangulaire ;
- retrouver les dalles LiDAR HD IGN associées ;
- charger une dalle COPC dans iTowns ;
- préparer l'ajout du MNT, des filtres de classification LiDAR et de CoSIA ;
- naviguer avec une caméra libre ;
- exposer un serveur local pour le cache, les fichiers locaux et les futurs traitements PDAL.

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
web/                 interface iTowns, vues, sélection LiDAR et COPC expérimental
server/              API locale, proxy géocodage, proxy WFS LiDAR, cache et fichiers
configs/             catalogue logique des couches IGN
data/                fichiers locaux ignorés par Git
scripts/windows/     installation et lancement Surface Pro 9
```

## Roadmap

1. Recherche adresse + vues Plan IGN / Satellite / iTowns avancée.
2. Sélection rectangle + recherche WFS des dalles LiDAR.
3. Chargement COPC fiable, cache local, annulation et limites de taille.
4. Ajout MNT / terrain IGN réel.
5. Filtres LiDAR par classe, altitude, densité et taille des points.
6. Caméra type drone et manette.
7. Reconstruction bâtiments/arbres.
8. Physique simplifiée.
9. Passerelle PX4/MAVLink.

## Limites

Ce dépôt est un visualiseur géospatial expérimental. Il ne garantit ni l'actualité du terrain réel ni la sécurité d'un vol.

Licence : MIT.
