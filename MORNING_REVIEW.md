# Morning Review — HormoneRx Benchmark

Everything below was actually run overnight. Do not trust this self-report alone — verify at least the positive-case retrieval and one metric yourself (steps in "Your 5-point spot-check").

## Exact commands

```bash
# from the project root
npm install            # first time only
npm run dev            # start the app -> http://localhost:5173  (Demo mode, no API key)

npm run benchmark      # regenerate src/data/benchmark_results.json
npm run test           # 38 unit + integration tests
npm run typecheck      # tsc --noEmit
npm run build          # production build
```

## What ran and the result

| Step | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | **Pass** (no errors) |
| Tests | `npx vitest run` | **38 passed / 38** (4 files: schema, extract, pipeline, export) |
| Benchmark | `npx tsx scripts/run_benchmark.ts` | **20/20 pass** |
| Production build | `npx vite build` | **Success** (243 kB JS / 14 kB CSS) |
| E2E + screenshots | `node scripts/e2e_screenshots.mjs` (Playwright/Chromium) | **15/15 checks passed, 0 console errors**; desktop + mobile screenshots in `screenshots/` |

## Benchmark metrics (from `src/data/benchmark_results.json`)

| Metric | Value |
| --- | --- |
| Trigger precision / recall / F1 | 100% / 100% / 100% |
| Retrieval accuracy | 100% |
| Correct abstention rate | 100% |
| Negation accuracy | 100% |
| Historical-context accuracy | 100% |
| Citation coverage | 100% |
| Entity precision / recall | 100% / 100% |
| False-positive count | 0 |
| Unsupported-claim count | 0 |
| Pass rate | 100% (20/20) |
| Metadata | mode: demo · model: deterministic-demo-extractor · seed 42 · deterministic |

Note: 100% reflects the **deterministic demo pipeline** on synthetic cases written in the dataset's vocabulary — it validates harness consistency, not clinical accuracy. See `docs/EVALUATION.md`.

## The exact 3-case demo sequence (Analyze Case → sample buttons)

1. **Positive** — "The patient currently takes a combined oral contraceptive and carbamazepine." → **EVIDENCE_FOUND**, record **INT-001**, FSRH source shown.
2. **Negated** — "She uses a combined oral contraceptive but is not taking carbamazepine." → **EXCLUDED_CONTEXT**, no record, no alert.
3. **Ambiguous** — "She takes carbamazepine and says she uses contraception, but the method is unclear." → **MORE_INFORMATION_REQUIRED**, missing info listed.

## Your 5-point spot-check (don't skip)

1. Positive case retrieves **INT-001** with the FSRH link. ✔ verify on screen.
2. Negated case produces **no** alert (EXCLUDED_CONTEXT). ✔
3. Ambiguous case **abstains** (MORE_INFORMATION_REQUIRED). ✔
4. Records still match what you approve — see `VERIFICATION_TABLE.md`.
5. A UI metric matches the file: open **Benchmark**, confirm e.g. "Correct abstention 100%" equals `benchmark_results.json` → `metrics.correctAbstentionRate`.

## Records still needing your sign-off (physicianVerified: false)

**All six** (INT-001 … INT-006). Each has **zero `[VERIFY]` fields** and cites a real, checkable section, so all six meet the criteria for attestation — they were left `false` so the physician claim is yours to make, not the agent's. Flip approved rows to `true` in `src/data/evidence_records.json` (see `VERIFICATION_TABLE.md`), then re-run `npm run test`.

Two things to catch specifically:
- **INT-005 (lamotrigine)** must be the **reversed** direction (contraceptive lowers lamotrigine → seizure-control risk), not the contraceptive losing efficacy. Confirmed reversed in the data and asserted by a test.
- **INT-006 (levonorgestrel EC)** must stay **non-directive** — no dose/copper-IUD advice in `potentialConsequence`. Confirmed excluded and asserted by a test.

## Unresolved issues / notes

- **`dist/` from an earlier build cannot be deleted** on this synced folder (a filesystem permission quirk); it is gitignored and irrelevant. `npm run build` regenerates a fresh bundle locally without issue.
- **Live mode** needs a deployed `/api/extract` (see `api/extract.example.ts` and `.env.example`). Demo mode is fully offline and is what the benchmark evaluates.
- Screenshots for review: `screenshots/desktop-0{1..7}-*.png` and `screenshots/mobile-0{1..3}-*.png`.

## Scope confirmation

Four sections + About only (Overview, Analyze Case, Evidence Library, Benchmark, About). No mcPHASES / NHANES / menstrual-cycle / population-survey pages. No patient accounts, EHR, dosing tools, diagnosis, or prescribing.
