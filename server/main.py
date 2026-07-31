from __future__ import annotations

# Garantit que .pdal-env est ajouté au PATH avant l'import de server.app.
# Python peut charger sitecustomize automatiquement, mais l'import explicite
# rend le bootstrap stable avec uvicorn et les fenêtres PowerShell.
import sitecustomize  # noqa: F401

from server.app import app
from server.frontend import mount_frontend
from server.instance_identity import router as runtime_identity_router
from server.observability import install_observability

app.include_router(runtime_identity_router)
install_observability(app)
mount_frontend(app)
