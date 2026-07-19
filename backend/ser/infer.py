#!/usr/bin/env python3
"""On-prem speech-emotion-recognition sidecar for the sound agent.

Reads a JSON request on stdin:
  {"model": "superb/wav2vec2-base-superb-er",
   "sample_rate": 16000,
   "segments": [{"segment_id": "...", "transcript": "...", "audio_path": null}]}

Runs an open-source SER model (transformers audio-classification, Apache-2.0) on
CUDA if available, and prints ONE JSON line on stdout:
  {"ok": true, "model": ..., "cuda": bool, "device": ..., "results": [...]}
On any failure prints {"ok": false, "error": ...} and exits 1, so the caller can
gate gracefully.

IMPORTANT: when a segment has no audio_path (no speech corpus recorded yet) a
DETERMINISTIC SYNTHETIC waveform is generated. That validates end-to-end
execution + GPU latency + the advisory event flow, but the emotion label on
synthetic audio is NOT meaningful — accuracy requires consented/synth speech.
"""
import hashlib
import json
import sys
import time
import wave

import numpy as np


def synth_waveform(seed_text: str, sr: int = 16000, seconds: float = 2.0) -> np.ndarray:
    """Deterministic non-speech waveform seeded by the text (for pipeline validation only)."""
    h = int(hashlib.sha256(seed_text.encode("utf-8")).hexdigest(), 16)
    rng = np.random.default_rng(h % (2**32))
    n = int(sr * seconds)
    t = np.arange(n) / sr
    f0 = 120 + (h % 80)
    sig = 0.1 * np.sin(2 * np.pi * f0 * t) + 0.05 * np.sin(2 * np.pi * (f0 * 2) * t)
    sig += 0.02 * rng.standard_normal(n)
    return sig.astype(np.float32)


def load_wav(path: str, sr: int = 16000) -> np.ndarray:
    with wave.open(path, "rb") as w:
        frames = w.readframes(w.getnframes())
        arr = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        if w.getnchannels() > 1:
            arr = arr.reshape(-1, w.getnchannels()).mean(axis=1)
        return arr


def main() -> None:
    req = json.load(sys.stdin)
    model_id = req.get("model", "superb/wav2vec2-base-superb-er")
    sr = int(req.get("sample_rate", 16000))
    segments = req.get("segments", [])

    try:
        import torch
        from transformers import pipeline

        cuda = torch.cuda.is_available()
        device = 0 if cuda else -1
        devname = torch.cuda.get_device_name(0) if cuda else "cpu"
        clf = pipeline("audio-classification", model=model_id, device=device, top_k=5)
    except Exception as e:  # noqa: BLE001 — report any load failure as JSON, gate upstream
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)

    results = []
    for seg in segments:
        ap = seg.get("audio_path")
        try:
            arr = load_wav(ap, sr) if ap else synth_waveform(seg.get("transcript") or seg["segment_id"], sr)
            audio_kind = "file" if ap else "synthetic"
        except Exception:  # noqa: BLE001 — fall back to synthetic on any read error
            arr = synth_waveform(seg.get("transcript") or seg["segment_id"], sr)
            audio_kind = "synthetic"
        t0 = time.time()
        preds = clf({"array": arr, "sampling_rate": sr})
        ms = (time.time() - t0) * 1000.0
        top = preds[0]
        results.append({
            "segment_id": seg["segment_id"],
            "label": top["label"],
            "score": round(float(top["score"]), 4),
            "scores": {p["label"]: round(float(p["score"]), 4) for p in preds},
            "latency_ms": round(ms, 2),
            "audio": audio_kind,
        })

    print(json.dumps({"ok": True, "model": model_id, "cuda": cuda, "device": devname, "results": results}))


if __name__ == "__main__":
    main()
