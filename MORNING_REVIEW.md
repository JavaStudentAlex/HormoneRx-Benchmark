# Morning Review — HormoneRx v0.2.0 (realtime engine)

Everything below was actually run during the build. Do not trust this self-report alone —
the 5-point spot-check takes ~3 minutes.

## Exact commands

```bash
npm install
cd backend && uv venv .venv && uv pip install -p .venv/bin/python -r requirements.txt && cd ..

npm run backend             # FastAPI engine on :8000
npm run dev                 # React app on :5173  ->  open http://localhost:5173/#/live

npm run backend:test        # backend pytest suite
npm run benchmark:backend   # Layers A+B (+C gate) -> backend/data/benchmark_results.json
npm run test && npm run typecheck && npm run build   # frontend
```

## What ran and the result

| Step | Command | Result |
| --- | --- | --- |
| Backend tests | `pytest` | **91 passed / 91** (evidence, normalization, context, graph, warning lifecycle, realtime events, API+WS) |
| Frontend tests | `vitest run` | **38 passed / 38** |
| Typecheck | `tsc --noEmit` | **Pass** |
| Production build | `vite build` | **Success** (285 kB JS / 80 kB gzip) |
| Benchmark Layer A (text, 23 cases) | `python -m app.benchmark` | **23/23**, trigger P/R/F1 100%, citation coverage 100%, unsupported claims 0 |
| Benchmark Layer B (streaming, 10 sequences) | same | **10/10**, per-event state accuracy 100%, retraction accuracy 100%, premature warnings 0, duplicate warnings 0 |
| Benchmark Layer C (audio) | same | **SKIPPED — honestly**: no recordings, no API key. Manifest + gold labels frozen. |
| End-to-end UI (Playwright, real browser against both servers) | scripted drive of `#/live` | **23/23 checks**, 0 console errors; screenshots `screenshots/desktop-08..10-live-*.png` |

Backend processing latency over the streaming benchmark: median 0.6 ms, p90 ~1 ms per
turn (deterministic extractor, no network). Live-model latency is **unmeasured**.

## What was verified end-to-end in the browser

1. Consent notice before capture; listening starts only on explicit action; red
   recording indicator + session duration; stop/clear work.
2. Demo 2 script: captions stream as provisional; the INT-001 warning appears **only**
   after the pair completes; the correction turn flips it to **RETRACTED** with the
   reason and the correcting turn shown; the superseded assertion is in the audit drawer.
3. Proposal flow: current combined pill + proposed lamotrigine → proposed-context
   INT-005 warning (reversed direction); cancel → visible retraction.
4. Speaker shortcuts D/P; `/analyze` redirects to the text tab; the text tab works with
   the backend stopped.

## NOT verified (be aware before the live demo)

- **Live microphone → provider transcription.** Implemented (ephemeral-credential
  endpoint + server-side relay + browser capture) but never exercised against the real
  API — no key in the build environment. Smoke-test with a key before demoing live mode;
  the fallback demo scripts do not depend on it.
- **Layer C audio benchmark** — not executed (see above).
- `TRANSCRIPTION_MODEL=gpt-realtime-whisper` comes from the task spec and is env-configurable;
  confirm the model name against current provider docs when you first run live mode.

## Records still needing your sign-off (physicianVerified: false — all six)

Unchanged medical prose from v0.1.0 (byte-identical, asserted by a test). New for your
review in `VERIFICATION_TABLE.md` addendum: derived hormonal-concept mappings
(INT-001/002/005), closed-class member lists (INT-003/004/006), and the new
"the pill = ambiguous, always abstain" behavior.

Until you flip the flags, the demo runs under `EVIDENCE_ALLOW_PENDING_VERIFICATION=true`
(development only, forced off in production) and **every warning carries a red
"physician sign-off pending" badge**. After sign-off, restart the backend and the badge
switches to physician-verified with no other change.

## Your 5-point spot-check

1. Open `#/live`, play **Demo 2** → warning after turn 4, retracted with reason after turn 5. ✔ on screen.
2. Play **Demo 4** ("the pill") → abstains with the missing-method question, no warning.
3. Play **Demo 5** (sister) → no patient warning; sister's carbamazepine under "Other subjects".
4. Open **Benchmark** page → "Realtime backend benchmark" stats match `backend/data/benchmark_results.json`.
5. `VERIFICATION_TABLE.md` addendum: approve or amend the derived mappings, then flip flags + `npm run backend:test`.

## Demo sequence for the presentation

Demo 1 (incremental match) → Demo 2 (correction/retraction — the money shot) →
proposal + cancel via the UI → Demo 4 (ambiguity abstains) → Benchmark page →
Export audit JSON to show full provenance.
