# Morning Review — HormoneRx v0.3.0 (TypeScript end to end)

Everything below was actually run during the build. Do not trust this self-report alone —
the 5-point spot-check takes ~3 minutes.

**v0.3.0**: the Python (FastAPI) backend was ported 1:1 to TypeScript (Node + Express + ws)
so the whole project is one language. Same routes, same WS protocol, same JSON wire
format — the React app is unchanged. The port reproduces all 96 backend tests and
identical benchmark metrics; the UI was re-verified in a real browser against the
TypeScript server (15/15 checks, 0 console errors).

## Exact commands

```bash
npm install                 # one install for frontend AND backend

npm run backend             # TypeScript engine on :8000 (tsx backend/src/server.ts)
npm run dev                 # React app on :5173  ->  open http://localhost:5173/#/live

npm run backend:test        # backend Vitest suite (96 tests)
npm run benchmark:backend   # Layers A+B (+C gate) -> backend/data/benchmark_results.json
npm run test && npm run typecheck && npm run build   # frontend + backend typecheck
```

## What ran and the result

| Step | Command | Result |
| --- | --- | --- |
| Backend tests | `npm run backend:test` | **96 passed / 96** (evidence, normalization, context, graph, warning lifecycle, realtime events, API+WS against a real listening server) |
| Frontend tests | `vitest run` | **38 passed / 38** |
| Typecheck (frontend + backend) | `npm run typecheck` | **Pass** |
| Production build | `vite build` | **Success** (286 kB JS / 80 kB gzip) |
| Benchmark Layer A (text, 24 cases) | `npm run benchmark:backend` | **24/24**, trigger P/R/F1 100%, citation coverage 100%, unsupported claims 0 |
| Benchmark Layer B (streaming, 13 sequences) | same | **13/13**, per-event state accuracy 100%, retraction accuracy 100%, premature warnings 0, duplicate warnings 0 |
| Benchmark Layer C (audio) | same | **SKIPPED — honestly**: no recordings, no API key. Manifest + gold labels frozen. |
| End-to-end UI vs TS backend (Playwright, real browser against both servers) | scripted drive of `#/live` | **15/15 checks**, 0 console errors (warning create/retract, conflict notes, proposal lifecycle, Demo 2 replay) |
| End-to-end UI, v0.2.x runs (Python engine, same wire format) | scripted drive of `#/live` | 23/23 + 5/5 checks; screenshots `screenshots/desktop-08..11-*.png` |

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
5. Improvement pass (v0.2.1), also driven live in the browser: negate→re-affirm
   flip-flop re-warns immediately with the contradiction surfaced in the new
   "Contradictions resolved by later statements" panel; "Sorry, I meant the combined
   pill" switches the warning INT-003→INT-001 with visible retraction; "considering
   starting the combined pill" while on carbamazepine raises the proposed-context
   warning at consideration time (screenshot `screenshots/desktop-11-conflict-notes.png`).

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
