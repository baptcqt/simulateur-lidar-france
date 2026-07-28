# Simulateur LiDAR France — prototype iTowns

Prototype web open source centré sur **iTowns** pour explorer les données IGN en 3D avant d'ajouter une couche de simulation de drone.

## État actuel

Le dépôt contient maintenant un vrai premier visualiseur :

- recherche d'adresse via le service de géocodage de la Géoplateforme ;
- déplacement automatique de la caméra vers le premier résultat ;
- choix entre trois vues de base : Satellite IGN, Plan IGN / topo et iTowns 3D neutre ;
- serveur FastAPI local qui sert de proxy de géocodage et préparera le cache ;
- aucune donnée OpenStreetMap.

Ce n'est pas encore un simulateur de drone. C'est le socle de visualisation sur lequel ajouter le LiDAR, le MNT, les filtres et la caméra drone.

## Objectif du MVP

- ouvrir une zone en France depuis une adresse ou des coordonnées ;
- afficher un globe/terrain iTowns ;
- basculer entre orthophoto IGN et Plan IGN ;
- préparer l'ajout du MNT, du LiDAR HD et de CoSIA ;
- naviguer avec une caméra libre ;
- exposer un petit serveur local pour le cache, les fichiers locaux et les futurs traitements PDAL.

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
web/                 interface iTowns, vues de base et recherche
server/              API locale, proxy géocodage, cache et fichiers de données
configs/             catalogue logique des couches IGN
data/                fichiers locaux ignorés par Git
scripts/windows/     installation et lancement Surface Pro 9
```

## Roadmap

1. Recherche adresse + vues Satellite / Plan IGN / iTowns.
2. Ajout MNT / terrain IGN réel.
3. Chargement COPC/Entwine et filtres LiDAR.
4. Caméra type drone et manette.
5. Reconstruction bâtiments/arbres.
6. Physique simplifiée.
7. Passerelle PX4/MAVLink.

## Limites

Ce dépôt est un visualiseur géospatial expérimental. Il ne garantit ni l'actualité du terrain réel ni la sécurité d'un vol.

Licence : MIT.
