# Simulateur LiDAR France — prototype iTowns

Prototype web open source centré sur **iTowns** pour explorer les données IGN en 2D/3D avant d'ajouter une couche de simulation de drone.

## État actuel

Le dépôt contient maintenant un premier visualiseur IGN stable :

- recherche d'adresse via le service de géocodage de la Géoplateforme ;
- déplacement automatique de la caméra vers le premier résultat ;
- démarrage en **BD topo / Plan IGN**, en vue 2D verticale ;
- choix entre trois fonds : **BD topo / Plan IGN**, **Satellite IGN** et **fond neutre iTowns** ;
- bascule d'angle entre **2D verticale du dessus** et **3D légère** ;
- une seule couche WMTS active à la fois pour limiter la charge réseau/GPU ;
- serveur FastAPI local qui sert de proxy de géocodage et préparera le cache ;
- aucune donnée OpenStreetMap.

Le bouton **fond neutre iTowns** ne charge ni image IGN ni LiDAR. iTowns est le moteur de rendu ; le LiDAR HD sera une couche séparée à ajouter dans une étape suivante.

Ce n'est pas encore un simulateur de drone. C'est le socle de visualisation sur lequel ajouter le MNT, le LiDAR HD, les filtres et la caméra drone.

## Objectif du MVP

- ouvrir une zone en France depuis une adresse ou des coordonnées ;
- afficher un globe/terrain iTowns ;
- basculer entre Plan IGN, orthophoto IGN et fond neutre ;
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

1. Recherche adresse + vues Plan IGN / Satellite / fond neutre.
2. Stabilisation navigation 2D/3D et gestion des erreurs de tuiles.
3. Ajout MNT / terrain IGN réel.
4. Chargement LiDAR HD COPC/Entwine et filtres LiDAR.
5. Caméra type drone et manette.
6. Reconstruction bâtiments/arbres.
7. Physique simplifiée.
8. Passerelle PX4/MAVLink.

## Limites

Ce dépôt est un visualiseur géospatial expérimental. Il ne garantit ni l'actualité du terrain réel ni la sécurité d'un vol.

Licence : MIT.
