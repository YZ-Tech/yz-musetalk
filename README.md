<!-- ─────────────────────────── JARVYZ SATELLITE ─────────────────────────── -->

# musetalk

[![JarvYZ](https://img.shields.io/badge/JARVYZ-Satellite-blue.svg?logoColor=white)](../../README.md)
[![Version](https://img.shields.io/badge/VERSION-0.1.0-blue.svg?logo=git&logoColor=white)](pyproject.toml)
[![Python](https://img.shields.io/badge/PYTHON-3.10–3.12-blue.svg?logo=python&logoColor=white)](pyproject.toml)
[![License](https://img.shields.io/badge/LICENSE-MIT-blue.svg?logo=opensourceinitiative&logoColor=white)](pyproject.toml)
[![Kind](https://img.shields.io/badge/KIND-library%20%2B%20Docker-blue.svg?logoColor=white)](#)
[![Port](https://img.shields.io/badge/PORT-8901-blue.svg?logoColor=white)](#)
[![Creator](https://img.shields.io/badge/CREATOR-Yeon-blue.svg?logo=github&logoColor=white)](https://github.com/YeonV)
[![Blade](https://img.shields.io/badge/A.K.A-Blade-darkred.svg?logo=github&logoColor=white)](https://github.com/YeonV)

<p align="left">
  <img src="ui/public/logo.svg" alt="JarvYZ" width="200">
</p>

> `yz-musetalk` — MuseTalk photoreal-face. WS lip-sync bridge + reference-clip CRUD. Library + upstream Docker container.

### Techs

[![FastAPI](https://img.shields.io/badge/x-FastAPI-blue.svg?logo=fastapi&logoColor=white&label=)](https://fastapi.tiangolo.com/)
[![React](https://img.shields.io/badge/x-React-blue.svg?logo=react&logoColor=white&label=)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/x-TypeScript-blue.svg?logo=typescript&logoColor=white&label=)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/x-Docker-blue.svg?logo=docker&logoColor=white&label=)](https://www.docker.com/)

**Run** `docker compose up` &nbsp;·&nbsp; **API** `/api/musetalk/*` · `/ws/musetalk_frames`

<!-- ───────────────────────────────────────────────────────────────────────── -->

<details>
<summary><b>Documentation</b></summary>

MuseTalk photoreal-face satellite — a coherent subsystem that owns:

- **The wrapper container** — Dockerfile + docker-compose + FastAPI wrapper code (`wrapper/main.py`) running at `:8901`. Refs CRUD, /set_active, /ws/say synthesis, /ws/say-frames out.
- **The JarvYZ-side integration** — `musetalk_client/` package (Python). Thin proxy at `/api/musetalk/*` → wrapper; WS re-broadcast on `/ws/musetalk_frames` during TTS dispatch; audio-encode helper for the TTS path.
- **The UI** — `ui/` (React, IIFE-bundled). V12 dashboard (PhotorealFace + refs dialog). Loaded by JarvYZ as a dynamic module; also served by the wrapper as a standalone SPA.

What stays **external** to this satellite:

- The upstream MuseTalk model code (`MuseTalk/` — vendored copy of the open-source repo, multi-GB)
- The model weights (`weights/` — multi-GB)

Both mount into the container from `${MUSETALK_HOME}` (default `/home/blade/projects/musetalk`).

Architecture: see [SATELLITE_DYNAMIC_MODULES.md](../../SATELLITE_DYNAMIC_MODULES.md) for the manifest+registry pattern.

## Run the container

```bash
cd satellites/yz-musetalk
docker compose up -d --build         # first run; rebuild if Dockerfile changed
docker compose up -d                 # subsequent starts
```

Override paths if the upstream MuseTalk repo lives elsewhere:

```bash
MUSETALK_HOME=/path/to/musetalk \
  MUSETALK_REFS_DIR=/path/to/refs \
  docker compose up -d
```

After ~10s the container is ready at `http://127.0.0.1:8901`:

- `GET /health` — `{ok, avatar, gpu}`
- `GET /refs` — list reference clips
- `POST /refs` — upload (multipart)
- `DELETE /refs/{name}` — delete
- `GET /refs/{name}` — serve raw bytes
- `POST /set_active` — swap active ref (`{ref: 'name.jpg'}`)
- `WS /ws/say` — WAV bytes in → frames out
- `POST /api/inference` — multipart audio → mp4 video (legacy non-streaming path)
- `GET /` — the standalone SPA (when `ui/` is built; see below)

## Build the UI

```bash
cd ui
npm install        # first time
npm run ship       # build:lib + install-to-frontend (IIFE → JarvYZ)
npm run build:pages # build SPA → ../wrapper/static (served by container at /)
```

`npm run ship` does the drift-check (manifest claims exist in IIFE), then copies the IIFE + manifest to both `frontend/public/modules/` and `web/static/modules/`. JarvYZ loads it via `@yz-dev/react-dynamic-module` for dashboard variant 12.

`npm run build:pages` emits the SPA into `../wrapper/static/`, which the wrapper container's StaticFiles mount serves at `/`. So `http://127.0.0.1:8901/` becomes a browsable UI without JarvYZ.

## JarvYZ-side public surface

`musetalk_client` (Python) is editable-installed in JarvYZ's venv:

```python
from yz_musetalk_client import (
    # Audio dispatch (called from TTS for warmup + per-utterance)
    dispatch, dispatch_blocking, set_force_dispatch,
    # Lifecycle (boot)
    bind_loop, ensure_refs_dir,
    # WS subscriber bookkeeping (for /ws/musetalk_frames re-broadcast)
    subscribe, unsubscribe, num_subscribers,
    set_active_ref,
    # FastAPI router for JarvYZ's web/server.py to include
    router,
)
```

The `router` exposes `/api/musetalk/refs` (proxied to wrapper), `/api/musetalk/active` (JarvYZ settings + wrapper), `/api/musetalk/status`, and `/ws/musetalk_frames`. See `musetalk_client/routes.py`.

## Manifest

`manifest.json` at this satellite's root declares its contributions:

- Dashboard variant `photoreal-face` (component `V12Dashboard`)
- Settings: `warmup_on_boot` (affectsBoot=true), `active_ref`

See [SATELLITE_DYNAMIC_MODULES.md](../../SATELLITE_DYNAMIC_MODULES.md) for the schema.

## Architecture

```
                   ┌───────────────────────────────────────────┐
                   │ Container: musetalk (this satellite)      │
                   │  /app/MuseTalk    (mounted from           │
                   │                    MUSETALK_HOME)         │
                   │  /app/wrapper     (mounted from this      │
                   │                    satellite's wrapper/)  │
                   │  /weights         (mounted, model weights)│
                   │  /refs            (mounted, ref clips)    │
                   │  uvicorn at :8000 → exposed as host :8901 │
                   └─────────────┬─────────────────────────────┘
                                 │ WS /ws/say  + REST /refs + GET /
                                 ▼
                   ┌─────────────────────────────────────────┐
                   │ JarvYZ (this repo)                      │
                   │                                         │
                   │  musetalk_client/  (Python)             │
                   │    ├ client.py  — WS dispatch + warmup  │
                   │    └ routes.py  — /api/musetalk/* proxy │
                   │                                         │
                   │  ui/  (React IIFE)                      │
                   │    └ V12Dashboard mounted on dashboard  │
                   │      variant 12                         │
                   └─────────────────────────────────────────┘
```

## Standalone use case

A friend running just the container — no JarvYZ, no Python venv:

```bash
cd satellites/yz-musetalk
docker compose up -d --build
xdg-open http://127.0.0.1:8901/     # or just navigate in a browser
```

Sees: V12 PhotorealFace backdrop + settings icon → opens refs dialog → uploads/deletes/swaps refs. Test-with-audio (drop a WAV, see synthesis output) is on the backlog.


</details>
