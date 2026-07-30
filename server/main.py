from __future__ import annotations

# Garantit que .pdal-env est ajouté au PATH avant l'import de server.app.
# Python peut charger sitecustomize automatiquement, mais l'import explicite
# rend le bootstrap stable avec uvicorn --reload et les fenêtres PowerShell.
import sitecustomize  # noqa: F401

from server.app import app
