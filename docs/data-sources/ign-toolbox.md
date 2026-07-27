# Registre IGN

| Ressource | Classement | Rôle | Licence/contrôle | Matériel/volume | État et risque |
|---|---|---|---|---|---|
| LiDAR HD classifié | MVP | géométrie prioritaire | vérifier fiche produit/licence ouverte | CPU, très volumineux | adaptateur local/COPC; millésimes variables |
| MNT LiDAR HD | MVP | terrain de référence | vérifier métadonnées | CPU, modéré | import GeoTIFF |
| MNS/MNH | MVP/repli | ruptures et hauteur | vérifier produit | CPU, modéré | import raster |
| BD ORTHO, Ortho-Express, vraie ortho | MVP | observation planimétrique/RGB | licence produit | stockage élevé | téléchargement ciblé |
| CoSIA | option | occupation fine | licence/dates | CPU | contrôle temporel requis |
| BD TOPO | MVP | recherche, topologie, sémantique, repli | licence produit | modéré | jamais vérité géométrique finale |
| OCS GE, RNB, BD Forêt, BD Haie | option | contrôles et sémantique | selon produit | modéré | adaptateurs prévus |
| Panoramax | contrôle externe | preuve visuelle | vérifier licence des images | réseau | non géométrique |
| Géoplateforme | MVP online | découverte et accès | contrats/API évolutifs | réseau | URL centralisées |
| ign-pdal-tools | option MVP | outils PDAL IGN | vérifier dépôt au pin | CPU | installation explicite |
| Myria3D, lidar-prod | IA optionnelle | classification | licences/poids à vérifier | GPU conseillé | désactivés |
| FRACTAL, FLAIR-1/HUB, MAESTRO | R&D | entraînement/segmentation | vérifier licences | gros volumes | non téléchargés |
| PureForest | R&D | forêt/essences | vérifier licence | GPU/données | ne pas sur-promettre l'essence |
| Sparkling WaSuRe | R&D | segmentation | vérifier licence | GPU | externe |
| MicMac, IGNMap | contrôle externe | photogrammétrie/inspection | licences propres | lourd | DevTools explicite |
| iTowns | MVP web | visualisation 3D | CeCILL-B | GPU intégré | interface progressive |

Chaque intégration réelle doit compléter URL officielle, version, licence, empreinte et date de validation dans le manifeste de build.
