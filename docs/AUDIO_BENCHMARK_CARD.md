# Audio Benchmark Card (Layer C)

**Status: manifest + frozen gold labels only. Not executed.**
The build environment has no recorded audio and no transcription credentials; results
are only ever reported for runs that actually happened
(`app/benchmark.py` reports the layer as SKIPPED with the reason).

## Purpose

Evaluate the full audio path — speech → realtime transcription → extraction → graph →
deterministic retrieval → warning lifecycle — under realistic speech conditions, with
error weighting that reflects clinical importance: one substituted medication name
matters more than many filler-word errors.

## Dataset

`backend/data/audio_benchmark_manifest.json` defines 6 cases (quiet room, background
noise, faster speech, brand vs generic name with spelling clarification, negation,
interruption + other-person attribution). Each case freezes: reference transcript with
speakers, critical entities, expected graph assertions/final state/evidence record, and
the expected warning lifecycle.

## Recording rules

- Synthetic speech only: consenting team members or TTS voices. **Never real patient audio.**
- WAV, 16-bit PCM, mono, ≥16 kHz, one file per case, names as listed in the manifest,
  placed under `backend/data/audio/`.
- Accents may be represented only by consenting team members or synthetic voices.

## Metrics (spec §26.1 + §26.4–26.6)

Medication-entity recall · hormonal-entity recall · medication substitution errors ·
negation preservation · temporal-phrase preservation · clinically-important transcript
error count · per-turn state accuracy · final-state accuracy · warning lifecycle
correctness · speech-end→final-transcript and final-transcript→UI-result latency
(reported as individual runs while samples are few).

## How to run

```bash
cd backend
OPENAI_API_KEY=… npx tsx backend/src/benchmark.ts --layer audio
```

Until recordings exist the command reports SKIPPED; that honest gap is part of the
result, not a failure of the harness.
