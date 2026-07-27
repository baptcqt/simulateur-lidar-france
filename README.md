# Simulateur LiDAR France

Prototype vertical open source, CPU-first, destiné à créer des maps 3D locales depuis des données IGN ou des fichiers locaux. 

## Démarrage Windows 11

```powershell
git clone <URL_DU_DEPOT>
cd simulateur-lidar-france
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows\bootstrap.ps1 -Profile Surface -WithGodot
.\scripts\windows\run.ps1
```

Sans installation complète, le jeu synthétique peut être construit avec Python 3.11+ :

```powershell
python -m pip install -e ".[dev]"
simmap demo build --output data/projects/demo --fidelity 45
simmap quality report --project data/projects/demo
simmap serve
```

API : `http://127.0.0.1:8000` — interface : `http://127.0.0.1:5173`.

## Parcours MVP

Le jeu de démonstration contient un MNT synthétique, un bâtiment à toit incliné, une route, un accès privé, quatre arbres et un petit pont. `simmap demo build` produit des chunks GLB, un manifeste traçable, un rapport qualité JSON/HTML, un paquet Godot et un monde SDF simplifié.

## Données réelles IGN

`simmap project create`, `simmap sources discover` et `simmap sources fetch` sont conçus pour des ressources configurées dans `configs/ign-resources.yml`. Le téléchargement est ciblé, avec cache hors dépôt, reprise et empreinte SHA-256. Les URL officielles changeantes doivent être validées avant chaque campagne d'acquisition.

## Limites honnêtes

Le MVP fournit une reconstruction déterministe simplifiée. Les bâtiments utilisent un LoD2 paramétrique lorsque les points sont suffisants, sinon LoD1. Les arbres sont individualisés par maxima locaux et enveloppes ellipsoïdales. L'acquisition IGN en ligne dépend des capacités et contrats de service publiés au moment d'utilisation. PX4/Gazebo est optionnel sous WSL2. Ce logiciel ne garantit ni l'actualité ni la sécurité opérationnelle d'un vol réel.

Voir `docs/architecture/overview.md`, `docs/data-sources/ign-toolbox.md` et `docs/troubleshooting/surface-pro.md`.
