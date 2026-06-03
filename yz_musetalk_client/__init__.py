"""MuseTalk client satellite — JarvYZ's integration layer for the
upstream MuseTalk Docker container.

The actual rendering service is OUT OF SCOPE for this satellite. It
runs as a Docker container started outside this repo (see README.md
for the container contract). This package owns only the JarvYZ-side
integration: the WS bridge that pumps TTS audio → wrapper and
re-broadcasts JPG frames, plus the REST routes for reference-clip
CRUD.

Public surface (re-exported from .client + .routes):
  - dispatch, dispatch_blocking, set_force_dispatch
  - bind_loop, subscribe, unsubscribe, num_subscribers
  - ensure_refs_dir, set_active_ref
  - router (FastAPI APIRouter with /api/musetalk/* + /ws/musetalk_frames)

Same surface as the legacy `pipeline.musetalk_client` + `web.api.musetalk`
combo — re-import paths only.
"""
from __future__ import annotations

from .client import (
    MUSETALK_HTTP_URL,
    MUSETALK_WS_URL,
    bind_loop,
    dispatch,
    dispatch_blocking,
    ensure_refs_dir,
    num_subscribers,
    set_active_ref,
    set_force_dispatch,
    subscribe,
    unsubscribe,
)
from .routes import router

__all__ = [
    "MUSETALK_HTTP_URL",
    "MUSETALK_WS_URL",
    "bind_loop",
    "dispatch",
    "dispatch_blocking",
    "ensure_refs_dir",
    "num_subscribers",
    "router",
    "set_active_ref",
    "set_force_dispatch",
    "subscribe",
    "unsubscribe",
]
