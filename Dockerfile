# MuseTalk environment for Jarvis v12.
# Base: NVIDIA's CUDA 11.8 + cuDNN 8 on Ubuntu 22.04.
# This matches MuseTalk's pinned PyTorch 2.0.1 + cu118 requirement;
# straying from these versions has been a documented landmine.

FROM nvidia/cuda:11.8.0-cudnn8-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# ── System deps ──────────────────────────────────────────────
# - python3.10 is Ubuntu 22.04's default
# - ffmpeg is a hard MuseTalk requirement (audio decode + video encode)
# - libgl1 / libsm6 / libxext6 / libglib2.0-0 — required by opencv
# - build-essential — needed for native wheels (chumpy, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.10 \
    python3-pip \
    python3.10-dev \
    git \
    wget \
    curl \
    ffmpeg \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libgl1 \
    build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.10 /usr/bin/python

# ── PyTorch 2.0.1 + CUDA 11.8 ────────────────────────────────
# These exact versions are non-negotiable for MuseTalk's mmcv 2.0.1 / mmpose 1.1.0 stack.
RUN pip install --no-cache-dir \
    torch==2.0.1 torchvision==0.15.2 torchaudio==2.0.2 \
    --index-url https://download.pytorch.org/whl/cu118

# ── MMLab ecosystem ─────────────────────────────────────────
# openmim manages the version matrix. The order matters: engine first,
# then mmcv, then the model-zoo packages.
RUN pip install --no-cache-dir -U openmim \
    && mim install mmengine \
    && mim install "mmcv==2.0.1" \
    && mim install "mmdet==3.1.0" \
    && mim install "mmpose==1.1.0"

# ── MuseTalk's own runtime deps ──────────────────────────────
# We bake these into the image (matches upstream requirements.txt) so
# every `docker compose up --force-recreate` doesn't wipe a layer we'd
# otherwise be reinstalling at container start. huggingface_hub is
# pinned <1.0 to keep `huggingface-cli` + transformers/tokenizers
# compatibility.
RUN pip install --no-cache-dir \
    "diffusers==0.30.2" \
    "accelerate==0.28.0" \
    "numpy==1.23.5" \
    "tensorflow==2.12.0" \
    "tensorboard==2.12.0" \
    "opencv-python==4.9.0.80" \
    "soundfile==0.12.1" \
    "transformers==4.39.2" \
    "huggingface_hub==0.30.2" \
    "librosa==0.11.0" \
    "einops==0.8.1" \
    "gradio==5.24.0" \
    gdown \
    "requests<2.32" \
    "imageio[ffmpeg]" \
    omegaconf \
    ffmpeg-python \
    moviepy

# ── Wrapper-service deps (FastAPI + uvicorn + refs CRUD) ─────
# Pillow needed for the refs CRUD upload path (resize images on upload
# to ≤1024px and re-encode as JPEG q92). Likely already pulled in by
# transformers/diffusers transitively, but we declare it explicitly so
# a future image rebuild without those big deps still has refs working.
RUN pip install --no-cache-dir \
    fastapi \
    "uvicorn[standard]" \
    websockets \
    python-multipart \
    Pillow

WORKDIR /app
