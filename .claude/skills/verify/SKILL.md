---
name: verify
description: Build, launch, and drive HormoneRx (React frontend + TypeScript realtime backend) end-to-end to verify changes at the real UI/API surface.
---

# Verifying HormoneRx changes

## Launch

```bash
# Backend (TypeScript: Express + ws, port 8000) — no venv, plain npm install
npm run backend          # = tsx backend/src/server.ts

# Frontend (Vite dev server, port 5173; proxies /api and /ws to :8000)
npm run dev
```

Health check: `curl localhost:8000/api/health` and `curl localhost:5173/api/health` (proxy).

## Gotchas

- **HashRouter**: pages are at `http://localhost:5173/#/live`, `#/benchmark`, etc. Plain `/live` renders the Overview (index route) — always include the `#`.
- Playwright is a devDependency; from scripts outside the repo import `('/…/HormoneRx-Benchmark/node_modules/playwright/index.mjs')`.
- Demo mode (no `OPENAI_API_KEY`) is the default: microphone transcription is unavailable, but scripted demo replay, manual turns, proposals, and the text tab all exercise the full backend pipeline.

## Flows worth driving (Live Consultation, `#/live`)

1. **Start listening** → recording indicator + `ws: open` badge.
2. **Demo 2 script button** → after turn 4: `EVIDENCE_FOUND` with INT-001 warning card (FSRH source, provenance chain, "physician sign-off pending" badge); after turn 5: `RETRACTED` with visible reason + warning history entry.
3. **Manual turn** "I use the combined pill." → `MORE_INFORMATION_REQUIRED`; **Propose** "Lamotrigine" → proposed-context INT-005 warning; **Cancel** → retraction with reason.
4. **Clear encounter** resets all panels.
5. Text tab (`#/live?tab=text`) works with the backend down.

6. **Agent fleet panel** ("5 · Agent fleet"): shows "15/15 workers healthy · 17 registered"; "Show roster" lists all workers incl. the disabled washout sentinel; findings appear live (e.g. "the pill" → Ambiguity sentinel; combined pill + lamotrigine → Seizure-risk specialist alert). REST: `GET /api/fleet/status`, `/api/fleet/findings`, `/api/fleet/review-queue`, `POST /api/fleet/run`.

Backend-only checks: `npm run backend:test` (121 Vitest tests: engine + fleet incl. parity/error isolation + relay reconnect, real HTTP+WS API tests) and `npm run benchmark:backend` (writes real results; audio layer reports SKIPPED without recordings/key). Benchmarks run the baseline engine; fleet parity is asserted in `backend/tests/fleet.test.ts`.
