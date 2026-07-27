# Architecture

Flux : sélection d'emprise → catalogue/provenance → cache hors dépôt → traitements géodésiques en EPSG:2154 → repère local ENU → reconstruction déterministe → qualité → chunks GLB → Godot/Gazebo. BD TOPO reste une source de topologie et de sémantique, jamais la vérité géométrique finale. Les adaptateurs IA sont externes, désactivés et doivent retourner probabilité et incertitude.

Le MVP exécute les tâches localement; SQLite conserve projets et tâches. Une future file de jobs reste compatible sans ajouter une infrastructure serveur lourde.
