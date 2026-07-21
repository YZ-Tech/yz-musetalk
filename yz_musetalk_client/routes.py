"""JarvYZ-side routes for MuseTalk integration.

After the Tier-1.5 satellite extraction (2026-05-31), refs CRUD lives
in the wrapper container at :8901/refs/* (see
`satellites/yz-musetalk/wrapper/main.py`). This module is now a thin proxy
that forwards `/api/musetalk/refs/*` to the wrapper.

Two things remain JarvYZ-side:

1. **WS fan-out** of MuseTalk JPG frames. Frames generated during TTS
   dispatch (`musetalk_client.dispatch_blocking`) are pushed onto an
   in-process broadcaster that this WS subscribes to. Wire format
   matches the wrapper's: 4-byte big-endian frame_idx | JPG bytes.

2. **`POST /api/musetalk/set_active`**: shape-mirrors the wrapper's own
   `POST /set_active`. Side effect: persists `settings.voice.musetalk_active_ref`
   so the active ref survives JarvYZ restart (wrapper has no persistent
   state). The shape-mirror means the satellite's `createSatelliteApi`
   adapter — pointed at `apiBase='/api/musetalk'` — works against
   JarvYZ-embedded with no per-host adapter divergence.
"""
from __future__ import annotations

import asyncio

import httpx
from fastapi import APIRouter, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from jarvyz.pipeline.settings import settings

from . import client as musetalk_client


router = APIRouter()


# ───── Wrapper proxy plumbing ──────────────────────────────────────


_WRAPPER = musetalk_client.MUSETALK_HTTP_URL

# ONE pooled client for the process lifetime — a fresh AsyncClient per
# request paid TCP+TLS setup every call (FABLE satellites finding). The
# 15s default covers the JSON endpoints; the upload passes its own timeout
# per request.
_http = httpx.AsyncClient(timeout=15.0)


async def _wrapper_get(path: str) -> dict:
    """GET against the wrapper. Lifts 4xx/5xx from wrapper to JarvYZ."""
    r = await _http.get(f"{_WRAPPER}{path}")
    if r.status_code >= 400:
        raise HTTPException(r.status_code, r.text)
    return r.json()


async def _wrapper_delete(path: str) -> dict:
    r = await _http.delete(f"{_WRAPPER}{path}")
    if r.status_code >= 400:
        raise HTTPException(r.status_code, r.text)
    return r.json()


# ───── /api/musetalk/refs proxied to wrapper /refs ─────────────────


@router.get("/api/musetalk/refs")
async def list_refs() -> dict:
    """Forward to wrapper /refs and merge in JarvYZ-side active marker
    (the wrapper doesn't know which ref the user picked; that's
    JarvYZ-side persistent state)."""
    data = await _wrapper_get("/refs")
    active = settings.voice.musetalk_active_ref
    items = data.get("items", [])
    for item in items:
        item["is_active"] = item.get("name") == active
    return {"items": items, "active": active}


@router.post("/api/musetalk/refs")
async def upload_ref(file: UploadFile = File(...)) -> dict:
    """Forward the multipart upload to the wrapper. Wrapper does the
    image resize / video pass-through + writes to /refs."""
    content = await file.read()
    r = await _http.post(
        f"{_WRAPPER}/refs",
        files={
            "file": (
                file.filename or "upload",
                content,
                file.content_type or "application/octet-stream",
            )
        },
        timeout=60.0,
    )
    if r.status_code >= 400:
        raise HTTPException(r.status_code, r.text)
    return r.json()


@router.delete("/api/musetalk/refs/{name}")
async def delete_ref(name: str) -> dict:
    """Refuse to delete the currently-active ref BEFORE forwarding —
    the wrapper doesn't track active-state, so the gate is here."""
    if name == settings.voice.musetalk_active_ref:
        raise HTTPException(409, "cannot delete the active ref — switch first")
    return await _wrapper_delete(f"/refs/{name}")


@router.get("/api/musetalk/refs/{name}")
async def get_ref_file(name: str) -> StreamingResponse:
    """Stream the raw bytes from wrapper /refs/{name}. Uses httpx
    streaming so the proxy doesn't buffer multi-MB videos in memory."""
    client = httpx.AsyncClient(timeout=30.0)
    req = client.build_request("GET", f"{_WRAPPER}/refs/{name}")
    r = await client.send(req, stream=True)
    if r.status_code >= 400:
        body = await r.aread()
        await r.aclose()
        await client.aclose()
        raise HTTPException(r.status_code, body.decode("utf-8", "ignore"))

    async def _gen():
        try:
            async for chunk in r.aiter_bytes():
                yield chunk
        finally:
            await r.aclose()
            await client.aclose()

    return StreamingResponse(
        _gen(),
        media_type=r.headers.get("content-type", "image/jpeg"),
    )


# ───── /api/musetalk/set_active — JarvYZ-persisted, wrapper-applied ────
#
# Endpoint shape MIRRORS the wrapper's POST /set_active so the satellite's
# `createSatelliteApi({apiBase: '/api/musetalk'})` adapter — which targets
# `${apiBase}/set_active` POST {ref} — works against JarvYZ-embedded
# without per-host adapter branching. Same wire shape, same verb.
#
# Side effect: persist the active ref in JarvYZ settings so the V12
# backdrop survives JarvYZ restart (wrapper has no persistent active
# state; container boots with MUSETALK_AVATAR default).


class _SetActiveBody(BaseModel):
    ref: str


@router.post("/api/musetalk/set_active")
async def set_active(body: _SetActiveBody) -> dict:
    """Persist the active ref in JarvYZ settings + tell the wrapper to
    swap. Wrapper failure is non-fatal: JarvYZ setting still updates so
    the V12 backdrop reflects the choice even if the wrapper is down."""
    # Verify the ref exists on the wrapper side. Cheaper than asking
    # for a 404 from /set_active.
    refs_data = await _wrapper_get("/refs")
    names = {item.get("name") for item in refs_data.get("items", [])}
    if body.ref not in names:
        raise HTTPException(404, f"no ref '{body.ref}' on wrapper")

    settings.voice.musetalk_active_ref = body.ref
    from jarvyz.pipeline.settings import save as save_settings
    save_settings()

    wrapper_ok = await musetalk_client.set_active_ref(body.ref)
    return {"ok": True, "active": body.ref, "wrapper_ok": wrapper_ok}


# ───── /api/musetalk/status — JarvYZ-side info ─────────────────────


@router.get("/api/musetalk/status")
async def status() -> dict:
    """JarvYZ-side state: subscriber count + wrapper URL. Distinct from
    the wrapper's own /health endpoint (which reports GPU + avatar)."""
    return {
        "ok": True,
        "subscribers": musetalk_client.num_subscribers(),
        "wrapper_url": musetalk_client.MUSETALK_WS_URL,
    }


# ───── WS /ws/musetalk_frames — JarvYZ-side re-broadcast ───────────


@router.websocket("/ws/musetalk_frames")
async def musetalk_frames(ws: WebSocket) -> None:
    """Subscribe to the in-process frame broadcaster (filled by
    `musetalk_client.dispatch_blocking` during TTS) and forward each
    JPG to the connected browser. Same wire format as the wrapper's
    /ws/say: 4-byte BE frame_idx | JPG bytes."""
    await ws.accept()
    loop = asyncio.get_event_loop()
    q = musetalk_client.subscribe(loop)
    try:
        while True:
            payload: bytes = await q.get()
            await ws.send_bytes(payload)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        musetalk_client.unsubscribe(q)
        try:
            await ws.close()
        except Exception:
            pass
