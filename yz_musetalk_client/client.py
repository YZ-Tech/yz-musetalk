"""JarvYZ-side client for the MuseTalk container (v12 photoreal face).

Pattern mirrors `pipeline/tts_broadcast`:
  - A frame broadcaster keeps subscriber asyncio.Queues and fans JPG
    bytes out to every connected browser.
  - A `dispatch(audio_f32, sr)` entry point can be called from the sync
    TTS thread — it schedules a session task on the main asyncio loop
    that opens a WS to the MuseTalk wrapper, sends the WAV, and pushes
    each returned JPG into the broadcaster.

Self-gating: if no browser is subscribed to /ws/musetalk_frames, the
TTS dispatch becomes a no-op — we don't spend GPU on frames nobody
will see.
"""
from __future__ import annotations

import asyncio
import io
import struct
import threading
import time
from typing import Optional

import httpx
import numpy as np
import soundfile as sf
import websockets


# Match the wrapper's compose: MuseTalk runs in WSL Docker, port-bound
# to host 8901 — and per the windows_localhost_quirk memory the
# Windows side must hit 127.0.0.1, NOT "localhost".
MUSETALK_WS_URL = "ws://127.0.0.1:8901/ws/say"
MUSETALK_HTTP_URL = "http://127.0.0.1:8901"

# Loop reference set by `bind_loop()` from server startup.
_loop: Optional[asyncio.AbstractEventLoop] = None
_subscribers: list[tuple[asyncio.Queue, asyncio.AbstractEventLoop]] = []
_lock = threading.Lock()
# Cap each subscriber queue at ~1.5s of frames at 25fps so a slow
# client doesn't balloon memory.
_QUEUE_MAXSIZE = 40

# How many in-flight sessions we tolerate. 1 is the sane default — TTS
# is sequential, MuseTalk is sequential, and stacking sessions just
# steals GPU from the active one.
_session_lock = asyncio.Lock()

# When True, dispatch() / dispatch_blocking() ignore the "no subscribers
# → skip" gate and send to MuseTalk anyway, dropping frames silently if
# no browser is watching. Used at boot to piggyback the "Ready." TTS
# utterance as a warmup pass: the wrapper preloads CUDA kernels + mmcv
# lazy ops so the first real user utterance doesn't pay that cost.
_force_dispatch: bool = False


def set_force_dispatch(on: bool) -> None:
    """Toggle the subscriber-gate bypass. Used by TTS at boot to warm
    MuseTalk via the 'Ready.' greeting without requiring a browser to
    be connected. Cheap, idempotent."""
    global _force_dispatch
    _force_dispatch = on


def ensure_refs_dir() -> None:
    """Create ~/.jarvyz/musetalk_refs/ if absent, and seed it with the
    bundled megan.jpg so a fresh install has a working reference. Called
    once from runtime startup; safe to call repeatedly."""
    from pathlib import Path
    from jarvyz.pipeline.settings import MUSETALK_REFS_DIR

    MUSETALK_REFS_DIR.mkdir(parents=True, exist_ok=True)
    default = MUSETALK_REFS_DIR / "megan.jpg"
    if default.exists():
        return
    # Bundled source — copy from the frontend's public dir (only place
    # this file currently lives in the repo). Best-effort: if it's not
    # there, just leave the dir empty and let the user upload.
    bundled = Path(__file__).resolve().parents[1] / "frontend" / "public" / "megan.jpg"
    if bundled.exists():
        import shutil
        shutil.copy2(bundled, default)


async def set_active_ref(name: str, timeout_s: float = 15.0) -> bool:
    """Tell the wrapper which ref image to animate. Returns True on
    success. Non-fatal: if the wrapper's unreachable, log and return
    False — JarvYZ still functions, the photoreal face just won't show
    the new face until the wrapper's back up."""
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            r = await client.post(
                f"{MUSETALK_HTTP_URL}/set_active",
                json={"ref": name},
            )
            r.raise_for_status()
            print(f"[musetalk_client] set_active ok: {name}")
            return True
    except Exception as e:
        print(f"[musetalk_client] set_active failed: {e!r}")
        return False


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Called once from server startup so the sync `dispatch` can
    schedule coroutines on the right event loop."""
    global _loop
    _loop = loop


def subscribe(loop: asyncio.AbstractEventLoop) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
    with _lock:
        _subscribers.append((q, loop))
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    with _lock:
        _subscribers[:] = [(qq, ll) for qq, ll in _subscribers if qq is not q]


def num_subscribers() -> int:
    with _lock:
        return len(_subscribers)


def _broadcast_frame(payload: bytes) -> None:
    """Fan-out one frame to all subscribers (drop-on-overflow). Called
    from the session task running on the main loop, so the
    `call_soon_threadsafe` hop is unnecessary — direct put_nowait."""
    with _lock:
        subs = list(_subscribers)
    for q, _loop_unused in subs:
        try:
            q.put_nowait(payload)
        except asyncio.QueueFull:
            # Frontend can't keep up — drop. The next frame will land.
            pass


def _audio_to_wav_bytes(audio_f32: np.ndarray, sr: int) -> bytes:
    """Encode mono float32 audio to a WAV file in memory (PCM int16)."""
    buf = io.BytesIO()
    if audio_f32.ndim == 2:
        audio_f32 = audio_f32[:, 0]
    sf.write(buf, audio_f32, sr, subtype="PCM_16", format="WAV")
    return buf.getvalue()


async def _run_session(
    wav_bytes: bytes,
    first_frame_event: Optional[threading.Event] = None,
) -> None:
    """Open a WS to the MuseTalk wrapper, send the WAV, stream every
    incoming frame into the broadcaster. Wire format (see wrapper
    ws_say): binary frames = 4-byte big-endian frame_idx + JPG bytes;
    text "done" terminates the stream.

    If `first_frame_event` is set, signal it the moment the first
    frame arrives — lets `dispatch_blocking` wake the TTS thread so it
    can start audio playback in near-sync with the video.

    Runs under `_session_lock` so concurrent dispatches queue up rather
    than racing for the GPU."""
    async with _session_lock:
        t0 = time.time()
        frames = 0
        try:
            async with websockets.connect(MUSETALK_WS_URL, max_size=None) as ws:
                await ws.send(wav_bytes)
                async for msg in ws:
                    if isinstance(msg, (bytes, bytearray)):
                        # Re-broadcast the wrapper's wire format verbatim
                        # — the browser parses the same 4-byte header.
                        _broadcast_frame(bytes(msg))
                        frames += 1
                        if frames == 1 and first_frame_event is not None:
                            first_frame_event.set()
                    else:
                        # Text message: "done" or "error: …"
                        if msg == "done":
                            break
                        print(f"[musetalk_client] wrapper error: {msg}")
                        break
        except Exception as e:
            # Wrapper not reachable / WS closed mid-stream / etc.
            # Don't propagate — TTS playback shouldn't be blocked by
            # MuseTalk being down.
            print(f"[musetalk_client] session failed: {e!r}")
        finally:
            # Always release the waiter so a failed session doesn't
            # leave the TTS thread blocking forever.
            if first_frame_event is not None and not first_frame_event.is_set():
                first_frame_event.set()
            dt = time.time() - t0
            if frames > 0:
                print(
                    f"[musetalk_client] streamed {frames} frames in {dt:.2f}s "
                    f"({frames / dt:.1f} fps)"
                )


def dispatch(audio_f32: np.ndarray, sr: int) -> None:
    """Fire-and-forget: schedule a MuseTalk inference session on the
    main loop with this utterance's audio. Safe to call from the
    sync TTS thread. No-op if there are no frame subscribers (so we
    don't spend GPU rendering frames nobody will see) or if the loop
    hasn't been bound yet. The subscriber gate is bypassed when
    `set_force_dispatch(True)` is active (boot warmup)."""
    if _loop is None:
        return
    if num_subscribers() == 0 and not _force_dispatch:
        return
    wav = _audio_to_wav_bytes(audio_f32, sr)
    asyncio.run_coroutine_threadsafe(_run_session(wav), _loop)


def dispatch_blocking(
    audio_f32: np.ndarray,
    sr: int,
    timeout_s: float = 5.0,
) -> bool:
    """Variant of `dispatch` that blocks until the first frame has been
    received from the MuseTalk wrapper (or until the timeout). Returns
    True if we got a frame in time, False otherwise.

    Lets the TTS thread hold off `_play()` until the photoreal video is
    ready, so audio playback starts in near-sync with the video stream
    arriving at the browser. The browser then schedules each subsequent
    frame at audio-relative time (idx / fps) for drift correction.

    No-op (returns False) if there are no frame subscribers OR the loop
    isn't bound yet — TTS playback should not block on MuseTalk in
    either of those cases. The subscriber gate is bypassed when
    `set_force_dispatch(True)` is active (boot warmup)."""
    if _loop is None:
        return False
    if num_subscribers() == 0 and not _force_dispatch:
        return False
    first_frame_event = threading.Event()
    wav = _audio_to_wav_bytes(audio_f32, sr)
    asyncio.run_coroutine_threadsafe(
        _run_session(wav, first_frame_event=first_frame_event),
        _loop,
    )
    return first_frame_event.wait(timeout=timeout_s)
