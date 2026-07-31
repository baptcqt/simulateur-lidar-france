from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter

router = APIRouter(tags=["runtime"])
PROCESS_STARTED_AT = datetime.now(timezone.utc).isoformat()


def runtime_identity() -> dict[str, Any]:
    return {
        "instanceToken": os.environ.get("SIMULATEUR_INSTANCE_TOKEN"),
        "processId": os.getpid(),
        "parentProcessId": os.getppid(),
        "processStartedAt": PROCESS_STARTED_AT,
    }


@router.get("/runtime/identity")
def get_runtime_identity() -> dict[str, Any]:
    return runtime_identity()
