"""Quick WS benchmark: send a WAV, count frames, time the round-trip.
Run from inside the container (uses the bundled websockets pkg).
  docker compose exec musetalk python /app/wrapper/bench_ws.py
"""
import asyncio
import sys
import time
from pathlib import Path

import websockets

URL = "ws://127.0.0.1:8000/ws/say"
WAV = Path("/app/MuseTalk/data/audio/eng.wav")


async def main() -> int:
    wav = WAV.read_bytes()
    print(f"[bench] WAV size: {len(wav) / 1024:.1f} KB", flush=True)
    t0 = time.time()
    t_first = None
    frames = 0
    bytes_in = 0
    async with websockets.connect(URL, max_size=None) as ws:
        await ws.send(wav)
        async for msg in ws:
            if isinstance(msg, (bytes, bytearray)):
                if t_first is None:
                    t_first = time.time()
                frames += 1
                bytes_in += len(msg)
            else:
                # text message — likely "done" or "error: …"
                if msg == "done":
                    break
                print(f"[bench] server text: {msg}", flush=True)
                return 1
    dt = time.time() - t0
    ttfb = (t_first - t0) if t_first else None
    print(
        f"[bench] {frames} frames, {bytes_in / 1024:.0f} KB total, "
        f"total {dt:.2f}s, first-frame {ttfb:.2f}s, "
        f"throughput {frames / dt:.1f} fps "
        f"(audio is {frames / 25:.1f}s @ 25fps → {frames / 25 / dt:.2f}× realtime)",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
