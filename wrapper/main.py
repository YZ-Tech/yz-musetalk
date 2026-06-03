"""FastAPI wrapper for MuseTalk — keeps models + avatar warm in memory
so per-request cost is just the UNet+VAE inference, not the multi-second
model-load + face-detect dance.

Run inside the container:
  uvicorn wrapper.main:app --host 0.0.0.0 --port 8000

Endpoints:
  GET    /health              { ok, avatar, gpu }
  POST   /set_active          { ref: 'name.jpg' } — swap active avatar
  WS     /ws/say              binary WAV in → 4-byte idx + JPG frames out
  POST   /api/inference       multipart audio → mp4 video
  GET    /refs                list ref clips + metadata
  POST   /refs                upload one ref (multipart)
  DELETE /refs/{name}         delete a ref (active-ref forbidden)
  GET    /refs/{name}         stream the raw bytes of a ref
  GET    /                    standalone SPA (when ui/ is built)

Tier-1.5 satellite extraction (2026-05-31): refs CRUD moved here from
JarvYZ's `web/api/musetalk.py` so the wrapper owns the whole MuseTalk
side of the wire. The JarvYZ-side `yz_musetalk_client/routes.py` is now
a thin proxy."""
from __future__ import annotations

import io
import os
import re
import sys
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Optional

import numpy as np
import torch
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# MuseTalk imports live at /app/MuseTalk; wrapper at /app/wrapper.
sys.path.insert(0, "/app/MuseTalk")

import cv2  # noqa: E402
from transformers import WhisperModel  # noqa: E402
from musetalk.utils.audio_processor import AudioProcessor  # noqa: E402
from musetalk.utils.blending import get_image_blending, get_image_prepare_material  # noqa: E402
from musetalk.utils.face_parsing import FaceParsing  # noqa: E402
from musetalk.utils.preprocessing import get_landmark_and_bbox, read_imgs  # noqa: E402
from musetalk.utils.utils import datagen, load_all_model  # noqa: E402


# Config (override via env). Paths are absolute to the container layout.
MUSETALK_ROOT = Path("/app/MuseTalk")
VERSION = os.environ.get("MUSETALK_VERSION", "v15")
UNET_MODEL_PATH = MUSETALK_ROOT / "models" / "musetalkV15" / "unet.pth"
UNET_CONFIG = MUSETALK_ROOT / "models" / "musetalkV15" / "musetalk.json"
WHISPER_DIR = MUSETALK_ROOT / "models" / "whisper"
DEFAULT_AVATAR = os.environ.get("MUSETALK_AVATAR", "avator_megan")
DEFAULT_REFERENCE_VIDEO = os.environ.get(
    "MUSETALK_REF_VIDEO", str(MUSETALK_ROOT / "data" / "video" / "megan.mp4")
)
BATCH_SIZE = int(os.environ.get("MUSETALK_BATCH_SIZE", "20"))
EXTRA_MARGIN = int(os.environ.get("MUSETALK_EXTRA_MARGIN", "10"))
AUDIO_PADDING_LEFT = 2
AUDIO_PADDING_RIGHT = 2
FPS = 25


class Pipeline:
    """Wraps the MuseTalk inference pipeline. Models loaded once; avatar
    cached on disk so subsequent boots skip the slow face-detect pass.

    Single-avatar for now — pass 4 (JarvYZ settings UI) will add live
    switching by routing through `prepare_avatar`."""

    def __init__(self) -> None:
        self.device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
        print(f"[musetalk] loading models on {self.device}…", flush=True)
        t0 = time.time()
        vae, unet, pe = load_all_model(
            unet_model_path=str(UNET_MODEL_PATH),
            vae_type="sd-vae",
            unet_config=str(UNET_CONFIG),
            device=self.device,
        )
        self.vae = vae
        self.unet = unet
        self.pe = pe.half().to(self.device)
        self.vae.vae = self.vae.vae.half().to(self.device)
        self.unet.model = self.unet.model.half().to(self.device)
        self.timesteps = torch.tensor([0], device=self.device)
        self.weight_dtype = self.unet.model.dtype

        self.audio_processor = AudioProcessor(feature_extractor_path=str(WHISPER_DIR))
        self.whisper = (
            WhisperModel.from_pretrained(str(WHISPER_DIR))
            .to(device=self.device, dtype=self.weight_dtype)
            .eval()
        )
        self.whisper.requires_grad_(False)

        self.face_parser = FaceParsing(left_cheek_width=90, right_cheek_width=90)
        print(f"[musetalk] models loaded in {time.time() - t0:.1f}s", flush=True)

        # Avatar slots — populated by prepare_avatar.
        self.avatar_id: Optional[str] = None
        self.coord_list_cycle = None
        self.frame_list_cycle = None
        self.input_latent_list_cycle = None
        self.mask_list_cycle = None
        self.mask_coords_list_cycle = None

    def avatar_dir(self, avatar_id: str) -> Path:
        return MUSETALK_ROOT / "results" / VERSION / "avatars" / avatar_id

    def _video2imgs(self, video_path: Path, out_dir: Path) -> None:
        cap = cv2.VideoCapture(str(video_path))
        i = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            cv2.imwrite(str(out_dir / f"{i:08d}.png"), frame)
            i += 1
        cap.release()

    def prepare_avatar_from_image(self, avatar_id: str, image_path: Path) -> None:
        """Like prepare_avatar but for a single still image (no
        _video2imgs step). Writes one PNG frame, runs the same
        landmark + cache pipeline. Idempotent via the cached avatar
        dir — re-uploading the same content (= same avatar_id) skips
        the face-parse work."""
        adir = self.avatar_dir(avatar_id)
        if (adir / "latents.pt").exists():
            print(f"[musetalk] avatar '{avatar_id}' cached, loading", flush=True)
            self._load_avatar_cache(avatar_id)
            return
        print(f"[musetalk] preparing avatar '{avatar_id}' from image {image_path}…", flush=True)
        full_imgs = adir / "full_imgs"
        full_imgs.mkdir(parents=True, exist_ok=True)
        img = cv2.imread(str(image_path))
        if img is None:
            raise RuntimeError(f"could not decode {image_path}")
        cv2.imwrite(str(full_imgs / "00000000.png"), img)
        self._prepare_avatar_from_dir(avatar_id)

    def prepare_avatar(self, avatar_id: str, video_path: Path) -> None:
        """Idempotent: if a cache exists for this avatar id, load it.
        Otherwise extract face features from the reference video + cache."""
        adir = self.avatar_dir(avatar_id)
        if (adir / "latents.pt").exists():
            print(f"[musetalk] avatar '{avatar_id}' cached, loading", flush=True)
            self._load_avatar_cache(avatar_id)
            return
        print(f"[musetalk] preparing avatar '{avatar_id}' from {video_path}…", flush=True)
        full_imgs = adir / "full_imgs"
        full_imgs.mkdir(parents=True, exist_ok=True)
        self._video2imgs(video_path, full_imgs)
        self._prepare_avatar_from_dir(avatar_id)

    def _prepare_avatar_from_dir(self, avatar_id: str) -> None:
        """Shared finish for both video- and image-source paths: takes
        the frames in full_imgs/, computes landmarks + latents + masks,
        and writes the cache files. Sets the pipeline's active avatar
        on completion."""
        adir = self.avatar_dir(avatar_id)
        full_imgs = adir / "full_imgs"
        masks = adir / "mask"
        masks.mkdir(parents=True, exist_ok=True)
        (adir / "vid_output").mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        img_paths = sorted(full_imgs.glob("*.png"))
        coord_list, frame_list = get_landmark_and_bbox([str(p) for p in img_paths], 0)
        placeholder = (0.0, 0.0, 0.0, 0.0)
        latents = []
        for idx, (bbox, frame) in enumerate(zip(coord_list, frame_list)):
            if bbox == placeholder:
                continue
            x1, y1, x2, y2 = bbox
            if VERSION == "v15":
                y2 = min(y2 + EXTRA_MARGIN, frame.shape[0])
                coord_list[idx] = [x1, y1, x2, y2]
            crop = frame[y1:y2, x1:x2]
            resized = cv2.resize(crop, (256, 256), interpolation=cv2.INTER_LANCZOS4)
            latents.append(self.vae.get_latents_for_unet(resized))

        # Cycle forward+reverse so audio longer than the source video
        # loops smoothly. For a 1-frame still this just gives 2 copies.
        frame_list_cycle = frame_list + frame_list[::-1]
        coord_list_cycle = coord_list + coord_list[::-1]
        latent_list_cycle = latents + latents[::-1]
        mask_list_cycle: list = []
        mask_coords_list_cycle: list = []
        for i, frame in enumerate(frame_list_cycle):
            cv2.imwrite(str(full_imgs / f"{i:08d}.png"), frame)
            x1, y1, x2, y2 = coord_list_cycle[i]
            mode = "jaw" if VERSION == "v15" else "raw"
            mask, crop_box = get_image_prepare_material(
                frame, [x1, y1, x2, y2], fp=self.face_parser, mode=mode
            )
            cv2.imwrite(str(masks / f"{i:08d}.png"), mask)
            mask_list_cycle.append(mask)
            mask_coords_list_cycle.append(crop_box)

        torch.save(latent_list_cycle, str(adir / "latents.pt"))
        import pickle
        with open(adir / "coords.pkl", "wb") as f:
            pickle.dump(coord_list_cycle, f)
        with open(adir / "mask_coords.pkl", "wb") as f:
            pickle.dump(mask_coords_list_cycle, f)

        self.avatar_id = avatar_id
        self.coord_list_cycle = coord_list_cycle
        self.frame_list_cycle = frame_list_cycle
        self.input_latent_list_cycle = latent_list_cycle
        self.mask_list_cycle = mask_list_cycle
        self.mask_coords_list_cycle = mask_coords_list_cycle
        print(f"[musetalk] avatar prepared in {time.time() - t0:.1f}s", flush=True)

    def _load_avatar_cache(self, avatar_id: str) -> None:
        import glob
        import pickle
        adir = self.avatar_dir(avatar_id)
        self.input_latent_list_cycle = torch.load(str(adir / "latents.pt"))
        with open(adir / "coords.pkl", "rb") as f:
            self.coord_list_cycle = pickle.load(f)
        img_paths = sorted(glob.glob(str(adir / "full_imgs" / "*.png")))
        self.frame_list_cycle = read_imgs(img_paths)
        with open(adir / "mask_coords.pkl", "rb") as f:
            self.mask_coords_list_cycle = pickle.load(f)
        mask_paths = sorted(glob.glob(str(adir / "mask" / "*.png")))
        self.mask_list_cycle = read_imgs(mask_paths)
        self.avatar_id = avatar_id

    @torch.no_grad()
    def infer_gpu_batches(self, audio_path: Path):
        """Generator: GPU-only work. Yields (idx, raw_recon_ndarray) for
        each frame as the UNet+VAE produce them. Caller is responsible
        for blending the raw face crop into the source frame. Designed
        to be run on its own thread so the CPU blend pipeline can run
        in parallel on a second thread."""
        if self.avatar_id is None:
            raise RuntimeError("no avatar loaded")

        whisper_features, librosa_length = self.audio_processor.get_audio_feature(
            str(audio_path), weight_dtype=self.weight_dtype
        )
        whisper_chunks = self.audio_processor.get_whisper_chunk(
            whisper_features,
            self.device,
            self.weight_dtype,
            self.whisper,
            librosa_length,
            fps=FPS,
            audio_padding_length_left=AUDIO_PADDING_LEFT,
            audio_padding_length_right=AUDIO_PADDING_RIGHT,
        )

        idx = 0
        total = len(whisper_chunks)
        for whisper_batch, latent_batch in datagen(
            whisper_chunks, self.input_latent_list_cycle, BATCH_SIZE
        ):
            audio_features = self.pe(whisper_batch.to(self.device))
            latent_batch = latent_batch.to(device=self.device, dtype=self.unet.model.dtype)
            pred_latents = self.unet.model(
                latent_batch, self.timesteps, encoder_hidden_states=audio_features
            ).sample
            pred_latents = pred_latents.to(device=self.device, dtype=self.vae.vae.dtype)
            recon = self.vae.decode_latents(pred_latents)
            for res_frame in recon:
                if idx >= total:
                    return
                yield idx, res_frame
                idx += 1

    def blend_frame(self, idx: int, res_frame):
        """CPU-only: take a raw recon frame, resize to the source bbox,
        blend back into the source frame. Returns a BGR ndarray. Safe
        to call from a non-GPU thread."""
        bbox = self.coord_list_cycle[idx % len(self.coord_list_cycle)]
        ori = self.frame_list_cycle[idx % len(self.frame_list_cycle)].copy()
        x1, y1, x2, y2 = bbox
        res_resized = cv2.resize(res_frame.astype(np.uint8), (x2 - x1, y2 - y1))
        mask = self.mask_list_cycle[idx % len(self.mask_list_cycle)]
        mcb = self.mask_coords_list_cycle[idx % len(self.mask_coords_list_cycle)]
        return get_image_blending(ori, res_resized, bbox, mask, mcb)

    def infer_frames(self, audio_path: Path):
        """Single-threaded convenience wrapper: chains GPU + blend on
        one thread. Used by the file-mode HTTP path; the WS handler
        runs the two stages on separate threads for throughput."""
        for idx, res_frame in self.infer_gpu_batches(audio_path):
            try:
                yield idx, self.blend_frame(idx, res_frame)
            except Exception:
                continue

    @torch.no_grad()
    def infer(self, audio_path: Path) -> Path:
        """File-mode wrapper: collects frames from the generator, encodes
        to mp4, muxes audio, returns path. Slower than the WS path
        because of the on-disk encode."""
        if self.avatar_id is None:
            raise RuntimeError("no avatar loaded — call prepare_avatar first")
        adir = self.avatar_dir(self.avatar_id)
        tmp_dir = adir / "tmp"
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir)
        tmp_dir.mkdir(parents=True)

        t1 = time.time()
        idx = 0
        for idx, frame in self.infer_frames(audio_path):
            cv2.imwrite(str(tmp_dir / f"{idx:08d}.png"), frame)
        print(f"[musetalk] inferred {idx + 1} frames in {time.time() - t1:.1f}s", flush=True)

        temp_mp4 = adir / "temp.mp4"
        out_mp4 = adir / "vid_output" / f"{uuid.uuid4().hex}.mp4"
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "warning",
                "-r", str(FPS),
                "-f", "image2",
                "-i", str(tmp_dir / "%08d.png"),
                "-vcodec", "libx264",
                "-vf", "format=yuv420p",
                "-crf", "18",
                str(temp_mp4),
            ],
            check=True,
        )
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "warning",
                "-i", str(audio_path),
                "-i", str(temp_mp4),
                str(out_mp4),
            ],
            check=True,
        )
        temp_mp4.unlink(missing_ok=True)
        shutil.rmtree(tmp_dir)
        return out_mp4


app = FastAPI(title="MuseTalk Wrapper", version="0.1")
pipeline: Optional[Pipeline] = None


@app.on_event("startup")
def _startup() -> None:
    global pipeline
    pipeline = Pipeline()
    pipeline.prepare_avatar(DEFAULT_AVATAR, Path(DEFAULT_REFERENCE_VIDEO))


@app.get("/health")
def health() -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "avatar": pipeline.avatar_id if pipeline else None,
            "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        }
    )


class SetActiveBody(BaseModel):
    ref: str


_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv"}


@app.post("/set_active")
def set_active(body: SetActiveBody) -> JSONResponse:
    """Swap the active reference. Body: {ref: 'megan.jpg'} or {ref:
    'megan.mp4'}. Dispatches by extension: video refs go through the
    full prepare_avatar (frame-by-frame head motion cycled with audio);
    everything else is treated as a still image. Cache key includes mtime
    so a re-uploaded file with the same name re-parses."""
    if pipeline is None:
        raise HTTPException(503, "pipeline not ready")
    src = Path("/refs") / body.ref
    if not src.exists():
        raise HTTPException(404, f"ref not found: {body.ref}")
    mtime_ms = int(src.stat().st_mtime * 1000)
    ext = src.suffix.lower()
    if ext in _VIDEO_EXTS:
        avatar_id = f"vid_{src.stem}_{mtime_ms}"
        pipeline.prepare_avatar(avatar_id, src)
        kind = "video"
    else:
        avatar_id = f"img_{src.stem}_{mtime_ms}"
        pipeline.prepare_avatar_from_image(avatar_id, src)
        kind = "image"
    return JSONResponse({"ok": True, "active": body.ref, "avatar_id": avatar_id, "kind": kind})


@app.websocket("/ws/say")
async def ws_say(ws: WebSocket) -> None:
    """Audio in → JPG frames out, no disk I/O. Wire-format v0:
      client → server:
        binary message #1: raw bytes of a WAV file (the full clip)
      server → client (in order, one per frame):
        binary message: 4-byte big-endian frame_idx + JPG bytes
      then:
        text message: "done", then close

    The sync inference generator runs on a thread (`asyncio.to_thread`)
    so the event loop stays responsive to WS keepalive + send backpressure.
    """
    import asyncio

    await ws.accept()
    if pipeline is None:
        await ws.close(code=1011, reason="pipeline not ready")
        return
    try:
        msg = await ws.receive_bytes()
    except WebSocketDisconnect:
        return
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(msg)
        in_path = Path(tmp.name)
    t0 = time.time()
    frames_sent = 0
    SENTINEL = object()
    # 3-thread pipeline:
    #   GPU thread    → raw_q (recon frames from UNet+VAE)
    #   CPU thread    → jpg_q (resize + blend + JPG-encode the recons)
    #   async (here)  → WS    (send each JPG to the client)
    # The GIL releases during torch/cv2 calls so this gets real overlap:
    # GPU and CPU stages run concurrently for ~the same wall clock.
    import queue
    import threading

    raw_q: "queue.Queue[object]" = queue.Queue(maxsize=64)
    jpg_q: "queue.Queue[object]" = queue.Queue(maxsize=64)

    def gpu_worker():
        try:
            for idx, recon in pipeline.infer_gpu_batches(in_path):
                raw_q.put((idx, recon))
        except Exception as e:
            raw_q.put(("__error__", str(e)))
        finally:
            raw_q.put(SENTINEL)

    def cpu_worker():
        try:
            while True:
                item = raw_q.get()
                if item is SENTINEL:
                    break
                if isinstance(item, tuple) and item[0] == "__error__":
                    jpg_q.put(item)
                    break
                idx, recon = item
                try:
                    blended = pipeline.blend_frame(idx, recon)
                except Exception:
                    continue
                ok, jpg = cv2.imencode(
                    ".jpg", blended, [int(cv2.IMWRITE_JPEG_QUALITY), 70]
                )
                if ok:
                    jpg_q.put((idx, jpg.tobytes()))
        except Exception as e:
            jpg_q.put(("__error__", str(e)))
        finally:
            jpg_q.put(SENTINEL)

    threading.Thread(target=gpu_worker, daemon=True).start()
    threading.Thread(target=cpu_worker, daemon=True).start()
    try:
        while True:
            item = await asyncio.to_thread(jpg_q.get)
            if item is SENTINEL:
                break
            if isinstance(item, tuple) and item[0] == "__error__":
                await ws.send_text(f"error: {item[1]}")
                break
            idx, jpg_bytes = item
            await ws.send_bytes(idx.to_bytes(4, "big") + jpg_bytes)
            frames_sent += 1
        await ws.send_text("done")
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_text(f"error: {e}")
        except Exception:
            pass
    finally:
        in_path.unlink(missing_ok=True)
        print(
            f"[musetalk] ws: sent {frames_sent} frames in {time.time() - t0:.1f}s",
            flush=True,
        )
        try:
            await ws.close()
        except Exception:
            pass


@app.post("/api/inference")
async def inference(audio: UploadFile = File(...)) -> FileResponse:
    if pipeline is None:
        raise HTTPException(503, "pipeline not ready")
    suffix = Path(audio.filename or "in.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        in_path = Path(tmp.name)
    try:
        out_mp4 = pipeline.infer(in_path)
    finally:
        in_path.unlink(missing_ok=True)
    return FileResponse(
        out_mp4,
        media_type="video/mp4",
        filename=out_mp4.name,
    )


# ─────────────────── Reference-clip CRUD ───────────────────────────
#
# Wrapper owns /refs as of the Tier-1.5 satellite extraction (2026-05-31).
# Pre-migration this lived in JarvYZ's web/api/musetalk.py; moved here so
# the wrapper is the single source of truth for everything MuseTalk-side
# (synthesis, refs management, standalone UI). JarvYZ-side is now a
# thin proxy at /api/musetalk/refs/* → /refs/*.
#
# `/refs` on the host (where JarvYZ ~/.jarvyz/musetalk_refs lives) is
# bind-mounted into the container as /refs. The wrapper reads/writes
# those files directly.


_REFS_DIR = Path("/refs")
_MAX_DIM = 1024     # resize on upload
_JPG_QUALITY = 92
_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")
_VIDEO_MIME = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
}
# _VIDEO_EXTS already defined above (line ~377) — reuse it.


def _kind_for(name: str) -> str:
    return "video" if Path(name).suffix.lower() in _VIDEO_EXTS else "image"


def _sanitize(name: str) -> str:
    """Strip path separators + unsafe chars. Preserves the extension
    when it's a recognized video container so the wrapper can dispatch
    by extension; everything else is normalized to .jpg because images
    are re-encoded via Pillow at q92."""
    ext = ""
    if "." in name:
        ext = "." + name.rsplit(".", 1)[1].lower()
    stem = name.rsplit(".", 1)[0] if "." in name else name
    stem = _NAME_RE.sub("_", stem).strip("_") or "ref"
    if ext in _VIDEO_EXTS:
        return f"{stem}{ext}"
    return f"{stem}.jpg"


def _ref_info(p: Path) -> dict:
    """Metadata for one ref file. Images get pixel dims via Pillow;
    videos surface frame dims + duration via ffprobe. Best-effort —
    if probing fails we still return name/size so the user can delete
    a corrupt entry."""
    kind = _kind_for(p.name)
    info: dict = {
        "name": p.name,
        "size_bytes": p.stat().st_size,
        "kind": kind,
        "duration_s": None,
        "width": None,
        "height": None,
    }
    try:
        if kind == "video":
            import json
            r = subprocess.run(
                [
                    "ffprobe", "-v", "error", "-select_streams", "v:0",
                    "-show_entries", "stream=width,height,duration",
                    "-of", "json", str(p),
                ],
                capture_output=True, text=True, timeout=5,
            )
            if r.returncode == 0:
                data = json.loads(r.stdout or "{}")
                streams = data.get("streams") or []
                if streams:
                    s = streams[0]
                    info["width"] = s.get("width")
                    info["height"] = s.get("height")
                    dur = s.get("duration")
                    if dur:
                        info["duration_s"] = round(float(dur), 2)
        else:
            from PIL import Image
            with Image.open(p) as im:
                info["width"], info["height"] = im.size
    except Exception:
        pass
    return info


def _ensure_refs_dir() -> None:
    """Create /refs if absent. Safe to call repeatedly."""
    _REFS_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/refs")
def list_refs() -> dict:
    """List all reference clips + their metadata. No `active` field
    here — active state lives in pipeline (the in-memory avatar_id);
    callers track it separately. JarvYZ-side proxy merges with JarvYZ
    settings to surface the active marker to the UI."""
    _ensure_refs_dir()
    items = [_ref_info(p) for p in sorted(_REFS_DIR.iterdir()) if p.is_file()]
    return {"items": items}


@app.post("/refs")
async def upload_ref(file: UploadFile = File(...)) -> dict:
    """Multipart upload. Images: Pillow → ≤1024px → JPEG q92. Videos
    (.mp4/.webm/.mov/.mkv): stored as-is so prepare_avatar's
    cv2.VideoCapture can decode them. Returns the saved entry."""
    _ensure_refs_dir()
    if not file.filename:
        raise HTTPException(400, "missing filename")
    out_name = _sanitize(file.filename)
    out_path = _REFS_DIR / out_name
    raw = await file.read()
    if _kind_for(out_name) == "video":
        try:
            out_path.write_bytes(raw)
        except Exception as e:
            raise HTTPException(400, f"failed to save video: {e}")
        return _ref_info(out_path)
    try:
        from PIL import Image, ImageOps
        im = Image.open(io.BytesIO(raw))
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGB")
        w, h = im.size
        if max(w, h) > _MAX_DIM:
            scale = _MAX_DIM / max(w, h)
            im = im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        im.save(out_path, "JPEG", quality=_JPG_QUALITY)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"failed to decode/resize image: {e}")
    return _ref_info(out_path)


@app.delete("/refs/{name}")
def delete_ref(name: str) -> dict:
    """Delete one ref. The wrapper doesn't know which ref the host
    considers 'active' (that's host-side state), so the host-side proxy
    is responsible for refusing to delete an active ref before calling
    this endpoint. If the wrapper later grows host-aware active-state
    we revisit that gate."""
    safe = _sanitize(name)
    p = _REFS_DIR / safe
    if not p.exists():
        raise HTTPException(404, "not found")
    p.unlink()
    return {"deleted": safe}


@app.get("/refs/{name}")
def get_ref_file(name: str) -> FileResponse:
    """Serve the raw bytes so the browser doesn't need filesystem
    access. Used by ref thumbnails + V12 backdrop. Content-Type is
    set from the extension."""
    safe = _sanitize(name)
    p = _REFS_DIR / safe
    if not p.exists():
        raise HTTPException(404, "not found")
    ext = p.suffix.lower()
    media_type = _VIDEO_MIME.get(ext, "image/jpeg")
    return FileResponse(p, media_type=media_type)


# ─────────────────── Standalone SPA mount ─────────────────────────
#
# When the satellite UI is built (Phase 3 lands `npm run build:pages` →
# wrapper/static/), mounting this serves the SPA at http://127.0.0.1:8901/.
# Friend-running-just-the-container can browse there directly.
#
# Mounted LAST so explicit JSON / WS routes win. mkdir-on-import (same
# pattern as people satellite) means the mount survives a satellite
# rebuild-then-restart cycle without code change.

_static_dir = Path(__file__).parent / "static"
_static_dir.mkdir(parents=True, exist_ok=True)
app.mount(
    "/",
    StaticFiles(directory=str(_static_dir), html=True),
    name="static",
)
