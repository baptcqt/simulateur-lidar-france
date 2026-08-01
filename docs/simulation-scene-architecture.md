# Architecture cible du rendu Simulation

## Objectif

Le mode **Simulation simplifiée** doit afficher une scène 3D composée de toutes les sorties utiles produites pour une sélection IGN. Il ne doit pas être un alias du rendu `classification` d’iTowns.

Les modes `classification`, `elevation`, `intensity` et `color` restent des vues de diagnostic du nuage de points. Ils ne remplacent pas la scène Simulation et ne doivent pas détruire ses objets.

## Principe

Les algorithmes ne pilotent jamais directement iTowns. Chaque outil produit des **artefacts déclarés**. Un manifeste de scène rassemble ces artefacts, puis le frontend charge la scène avec des chargeurs génériques.

Flux cible :

```text
sélection IGN
  -> orchestration des traitements
      -> PDAL
      -> Myria3D
      -> futurs outils
  -> manifeste de scène versionné
  -> registre de chargeurs frontend
  -> preset Simulation dans iTowns
```

## Manifeste de scène

Chaque traitement doit compléter un manifeste commun, par exemple :

```json
{
  "schemaVersion": 1,
  "selection": {
    "bbox": { "minLon": 0, "minLat": 0, "maxLon": 0, "maxLat": 0 },
    "crs": "EPSG:2154"
  },
  "runs": [
    {
      "id": "pdal",
      "status": "completed",
      "version": "local",
      "artifacts": ["points.cleaned", "buildings.pdal"]
    }
  ],
  "artifacts": [
    {
      "id": "points.cleaned",
      "type": "copc",
      "role": "processed-points",
      "url": "/files/processed/.../selection.copc.laz",
      "producer": "pdal",
      "defaultVisible": true
    },
    {
      "id": "terrain.ign",
      "type": "itowns-elevation",
      "role": "terrain",
      "producer": "ign",
      "defaultVisible": true
    },
    {
      "id": "buildings.pdal",
      "type": "box-mesh-json",
      "role": "buildings",
      "url": "/files/processed/.../buildings.json",
      "producer": "pdal",
      "defaultVisible": true
    }
  ],
  "presets": {
    "simulation": {
      "visibleArtifacts": ["points.cleaned", "terrain.ign", "buildings.pdal"],
      "pointMode": "classification",
      "pointOpacity": 0.45
    }
  }
}
```

Myria3D ou un autre outil pourra ajouter des artefacts sans modifier le moteur de scène, par exemple `semantic-points`, `building-mesh`, `vegetation-mesh`, `ground-mesh` ou `road-surface`.

## Frontend

Le frontend doit être séparé en quatre responsabilités :

1. **Chargement et validation du manifeste** : vérifie la version, les URL et les artefacts disponibles.
2. **Registre de chargeurs** : associe chaque `artifact.type` à un chargeur iTowns/Three.js.
3. **Gestionnaire de scène** : crée, active, masque et détruit les objets sans connaître PDAL ou Myria3D.
4. **Presets de rendu** : `simulation` assemble les artefacts ; les modes de diagnostic modifient uniquement le rendu du nuage de points.

Chaque chargeur doit retourner une poignée uniforme :

```ts
type SceneArtifactHandle = {
  id: string;
  role: string;
  setVisible(visible: boolean): void;
  dispose(): void;
};
```

Le sélecteur doit contenir une valeur unique `simulation`. Les valeurs `classification`, `elevation`, `intensity` et `color` restent distinctes.

Les cases de la section **Couches** doivent être générées à partir des artefacts réellement disponibles. Une couche absente ou en échec doit être signalée, pas affichée comme active.

## Backend

Le job de traitement doit renvoyer une URL de manifeste, et non une accumulation de champs spécifiques comme `buildingsPath`.

Chaque adaptateur d’algorithme :

- reçoit la sélection, le CRS et les artefacts précédents nécessaires ;
- produit zéro ou plusieurs artefacts ;
- écrit son statut, sa version, ses métriques et ses erreurs ;
- ne connaît pas le code de rendu du navigateur.

Dans une première étape, les champs actuels `path` et `buildingsPath` peuvent rester pour compatibilité, mais le manifeste devient la source de vérité.

## Première intégration PDAL

Les sorties existantes deviennent :

- `selection.copc.laz` -> artefact `points.cleaned` ;
- `buildings.json` -> artefact `buildings.pdal` ;
- couche MNT IGN -> artefact `terrain.ign` déclaré par la scène ;
- métadonnées du profil et du budget -> configuration du preset.

Le mode Simulation doit alors :

- charger le COPC traité ;
- afficher le relief ;
- afficher les volumes bâtiment lorsque `buildingCount > 0` ;
- conserver les réglages de densité, taille et opacité ;
- permettre de passer aux diagnostics sans recharger la page ni perdre les artefacts.

## Non-régression

Les évolutions suivantes doivent être couvertes :

- schéma et version du manifeste ;
- existence de chaque fichier déclaré ;
- valeurs uniques dans le sélecteur de rendu ;
- activation effective des artefacts du preset Simulation ;
- absence de couche cochée lorsque son chargement a échoué ;
- conservation des artefacts lors du passage Simulation <-> diagnostics ;
- panneau latéral toujours contenu dans la hauteur visible et défilable ;
- test navigateur automatisé vérifiant qu’une scène traitée affiche au moins le nuage, le terrain et les volumes lorsqu’ils sont présents.

## Ordre d’implémentation

1. Introduire le manifeste versionné et conserver les réponses API actuelles pour compatibilité.
2. Créer le registre de chargeurs et le gestionnaire de scène.
3. Donner une valeur réelle `simulation` au sélecteur et brancher les sorties PDAL existantes.
4. Générer les cases de couches depuis le manifeste avec états `loading`, `ready`, `empty` et `error`.
5. Ajouter un test navigateur de la scène PDAL.
6. Intégrer Myria3D comme nouvel adaptateur producteur d’artefacts, sans modifier le cœur de la visionneuse.
