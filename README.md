# HormoneRx Benchmark

An open evidence dataset and benchmark for testing whether AI systems can recognize hormonal medication context in **real time** and retrieve verified interaction evidence **without generating unsupported clinical advice**.

Version 0.2.0 adds an audio-first, event-sourced **Python realtime engine**: it listens during a (synthetic) doctor–patient consultation, analyzes only finalized speech turns, maintains a provenance-linked encounter medication graph, matches it deterministically against physician-reviewed evidence records, and **visibly retracts** a warning when later speech corrects, negates, or historicizes an earlier statement.

> **Research prototype. Not medical advice.** Evidence is limited to the curated prototype dataset and requires verification against the cited source and individual clinical context. All six records currently await physician sign-off; warnings are labeled accordingly.

## What it is

- **Evidence dataset** (`backend/data/evidence_records.json`) — six source-linked interaction records between hormonal contraceptives and interacting medications (FSRH, CDC US-MEC, FDA lamotrigine label, MHRA), now with machine-matching metadata: explicit concept IDs, closed-class membership lists, and interaction-direction codes. Every medical statement is a close paraphrase of the cited source; v0.2.0 changed **no medical prose**.
- **Deterministic ontology** (`backend/data/synonym_index.json`) — approved synonyms, documented misspellings, and deliberately **ambiguous** aliases ("the pill", class words) that force abstention instead of guessing.
- **Realtime encounter engine** (`backend/`) — FastAPI + Pydantic, append-only event log, derived graph snapshot, graph invariant validation, deterministic pair lookup, and a full warning lifecycle (create → update → **retract with reason**). Partial captions are display-only and can never trigger anything.
- **Benchmarks** —
  Layer A: 24 labelled text snippets; Layer B: 13 streaming sequences with an expected state after **every** event (corrections, negations, late/out-of-order events, duplicate replays, proposal lifecycle); Layer C: frozen audio manifest + gold labels (execution requires recordings and a transcription key — reported honestly as skipped until then).
- **Web app** — the existing React/Tailwind app plus a **Live Consultation** page: session controls with consent notice, speaker selector (D/P shortcuts), live transcript with provisional captions, encounter-graph panel with a superseded-assertion audit drawer, and an evidence panel with provenance chains and warning history. Old Analyze Case lives on as the offline **Text analysis** tab.

## Safety boundary (non-negotiable)

The extraction model may **only** produce structured context (mentions, status, subject, spans, corrections, missing information). It never generates interactions, consequences, severity, citations, or advice. All visible medical content is loaded **verbatim** from the evidence file; a warning exists only when a deterministic index lookup matches active, patient-attributed, normalized assertions; the app never shows a green "safe" state. See `docs/SAFETY.md`.

## Quick start

```bash
npm install
cd backend && uv venv .venv && uv pip install -p .venv/bin/python -r requirements.txt && cd ..

npm run backend      # FastAPI engine  -> http://localhost:8000  (terminal 1)
npm run dev          # React app       -> http://localhost:5173  (terminal 2)
```

Open **http://localhost:5173/#/live** → *Start listening* → play a scripted demo conversation (works with **no API key**), or type manual turns. Live microphone transcription additionally needs `OPENAI_API_KEY` (see `.env.example`; secrets stay server-side).

Other commands:

```bash
npm run backend:test        # 96 backend tests (pytest)
npm run test                # 38 frontend tests (Vitest)
npm run benchmark:backend   # Layers A+B+C -> backend/data/benchmark_results.json
npm run benchmark           # legacy TS text benchmark (frontend demo pipeline)
npm run typecheck && npm run build
```

## Repository map

| Path | Purpose |
| --- | --- |
| `backend/app/` | Realtime engine: models, event store, graph reducer/validator, evidence index, normalizer, extractors, warning engine, benchmark runner, FastAPI API/WS |
| `backend/data/` | Canonical evidence + ontology + demo scripts + benchmark gold labels + generated results |
| `backend/tests/` | Evidence, normalization, context, graph, warning-lifecycle, realtime, API tests |
| `src/` | React app (Live Consultation, Evidence Library, Benchmark, About) |
| `docs/` | Dataset/benchmark/audio cards, realtime architecture, graph schema, labeling guide, evaluation, safety, privacy, limitations, demo guide |
| `HormoneRx_Research_Developer_Task_Spec.md` | The implementation specification this version follows |

## Documentation

[`docs/REALTIME_ARCHITECTURE.md`](docs/REALTIME_ARCHITECTURE.md) · [`docs/GRAPH_SCHEMA.md`](docs/GRAPH_SCHEMA.md) · [`docs/LABELING_GUIDE.md`](docs/LABELING_GUIDE.md) · [`docs/DATASET_CARD.md`](docs/DATASET_CARD.md) · [`docs/BENCHMARK_CARD.md`](docs/BENCHMARK_CARD.md) · [`docs/AUDIO_BENCHMARK_CARD.md`](docs/AUDIO_BENCHMARK_CARD.md) · [`docs/EVALUATION.md`](docs/EVALUATION.md) · [`docs/SAFETY.md`](docs/SAFETY.md) · [`docs/PRIVACY.md`](docs/PRIVACY.md) · [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) · [`docs/DEMO_GUIDE.md`](docs/DEMO_GUIDE.md) · [`VERIFICATION_TABLE.md`](VERIFICATION_TABLE.md) (physician sign-off) · [`MORNING_REVIEW.md`](MORNING_REVIEW.md) (what actually ran)

## Current results (deterministic demo pipeline — harness validation, not clinical accuracy)

Layer A: 24/24 · Layer B: 13/13 sequences, per-event state accuracy 100%, retraction accuracy 100%, premature warnings 0, duplicate warnings 0, citation coverage 100%, unsupported claims 0 · backend processing latency median < 1 ms per turn (no network). Layer C: not executed. **Benchmark performance does not establish clinical safety. Absence of a record is not evidence of absence of an interaction.**

## Stack

React + TypeScript + Vite + Tailwind (hand-built shadcn-style primitives) · Python 3.13 + FastAPI + Pydantic v2 · Vitest + pytest · Playwright for end-to-end checks and screenshots.
