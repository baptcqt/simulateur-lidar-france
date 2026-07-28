# Simulateur LiDAR France — prototype iTowns

Prototype web open source centré sur **iTowns** pour explorer les données IGN en 3D avant d'ajouter une couche de simulation de drone.

## Objectif du MVP

- ouvrir une zone en France depuis des coordonnées ;
- afficher un globe/terrain iTowns ;
- superposer une orthophoto IGN configurée ;
- préparer l'ajout du MNT, du LiDAR HD et de CoSIA ;
- naviguer avec une caméra libre ;
- exposer un petit serveur local pour le cache, les fichiers locaux et les futurs traitements PDAL.

Aucune donnée OpenStreetMap n'est utilisée.

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

## Configuration IGN

Copier `web/.env.example` vers `web/.env.local`, puis renseigner les URL de services IGN que vous souhaitez activer. Les endpoints sont volontairement configurables afin de ne pas figer des URL susceptibles d'évoluer.

## Architecture

```text
web/                 interface iTowns et caméra
server/              API locale, cache et fichiers de données
configs/             catalogue logique des couches IGN
data/                 fichiers locaux ignorés par Git
scripts/windows/      installation et lancement Surface Pro 9
```

## Roadmap

1. Terrain + BD ORTHO + recherche de coordonnées.
2. Chargement COPC/Entwine et filtres LiDAR.
3. Caméra type drone et manette.
4. Reconstruction bâtiments/arbres.
5. Physique simplifiée.
6. Passerelle PX4/MAVLink.

## Limites

Ce dépôt est un visualiseur géospatial expérimental. Il ne garantit ni l'actualité du terrain réel ni la sécurité d'un vol.

Licence : MIT.
