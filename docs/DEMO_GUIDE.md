# Demo Guide

A 3-minute walkthrough for judges. Everything runs in **Demo mode** with no API key.

## Start

```bash
npm install
npm run dev      # open http://localhost:5173
```

The header shows the persistent badges (Research prototype · Synthetic benchmark · Demo/Live mode · evidence version · benchmark version) and a disclaimer sits on every screen.

## The 3-case sequence (Analyze Case)

Go to **Analyze Case** and click the sample buttons in this order:

1. **Positive evidence match** →
   *"The patient currently takes a combined oral contraceptive and carbamazepine."*
   Result: **EVIDENCE_FOUND**, record **INT-001**, with the FSRH source, section, and link. Note that all medical wording is loaded from the record — the model only produced the extraction.

2. **Explicit negation** →
   *"She uses a combined oral contraceptive but is not taking carbamazepine."*
   Result: **EXCLUDED_CONTEXT** — the negated medication is excluded, no alert, no record shown.

3. **Incomplete hormonal context** →
   *"She takes carbamazepine and says she uses contraception, but the method is unclear."*
   Result: **MORE_INFORMATION_REQUIRED** — the missing information is listed; the system abstains rather than guessing.

(Also try **Historical medication** and **No validated match** to see EXCLUDED_CONTEXT and the exact no-match wording: *"No matching record was found in the current prototype evidence dataset."* + *"This does not establish that no interaction exists."*)

## Evidence Library

- Search e.g. `lamotrigine` to find the **reversed-direction** record (INT-005).
- Click **Details** to open the record drawer, including synonyms used for normalization.
- Use **Export CSV** / **Export JSON** (read-only dataset).

## Benchmark

- Every metric is read from `src/data/benchmark_results.json` (regenerate with `npm run benchmark`).
- Filter the case table by **Category** (e.g. `explicit_negation`) and **Outcome** (pass/fail).
- Read the caveat at the bottom: a high pass rate reflects harness consistency, not clinical accuracy.

## The point for judges

The reusable contribution is the **dataset + benchmark + reproducible evaluation**, not the UI. The model is boxed into extraction only; retrieval is deterministic; every medical statement is source-linked; and the system abstains and never shows a "safe" state.
