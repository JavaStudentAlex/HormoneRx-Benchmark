# Evaluation

## How to run

```bash
npm run benchmark
```

This runs `scripts/run_benchmark.ts`, which processes every case in `benchmark_cases.json` through the **deterministic demo pipeline** (`extractDeterministic` → `runLookup`) and writes real numbers to `src/data/benchmark_results.json` plus case-level results. Gold labels are never modified by the runner. If `OPENAI_API_KEY` is absent, the run is evaluated in demo mode and labelled as such; it never pretends a live-model run occurred.

The pipeline is fully deterministic (no randomness); `randomSeed` is recorded as 42 for provenance and `deterministic: true` is set in the metadata.

## Metrics (definitions)

- **Trigger precision / recall / F1** — treating an EVIDENCE_FOUND result as a positive "alert". A true positive requires the correct record to be retrieved.
- **Retrieval accuracy** — fraction of cases whose retrieved record id equals the expected record id (null == null counts as correct).
- **Correct abstention rate** — among cases with `expectedAbstention: true`, the fraction where the pipeline did not return EVIDENCE_FOUND.
- **Negation accuracy** — among `explicit_negation` cases, the fraction whose actual result state equals the expected state.
- **Historical-context accuracy** — among `historical_use` cases, the fraction whose actual result state equals the expected state.
- **Citation coverage** — among cases where a match is expected, the fraction where the correct record was retrieved **and** it carries a non-empty, real `sourceUrl` + `sourceSection` (displayed verbatim, never invented).
- **Entity precision / recall** — the decision to attempt a *record lookup*. Positive class = cases containing an identified hormonal product and a current **interacting** medication (`clear_positive`, `implicit_positive`). True negatives contain a current *non-interacting* medication, so correctly withholding the record lookup for them is not counted as a miss.
- **False-positive count** — EVIDENCE_FOUND results that were not expected, or that retrieved the wrong record.
- **Unsupported-claim count** — any displayed message that is neither a fixed non-medical UI string nor sourced verbatim from the retrieved record. Any value above 0 is a safety defect.

## Current results (demo pipeline, 20 cases)

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
| Pass rate | 100% |

**Pass** = actual result state equals expected state **and** retrieved record id equals expected record id.

## Interpreting these numbers

The deterministic extractor scores at ceiling because the synthetic cases use the dataset's own vocabulary. This validates that the harness, normalization, negation/temporality logic, retrieval, and abstention wording are internally consistent — it does **not** establish clinical accuracy. Treat the benchmark as a labelled test bed for scoring *other* (e.g. LLM) extractors on noisier, paraphrased input.

## The demo extractor's closed lexicons

To keep the demo deterministic and offline, `src/lib/extract.ts` uses:

- The dataset's own hormonal and medication synonyms for normalization.
- A small closed list of common **non-interacting** drug names (paracetamol, ibuprofen, sertraline, amlodipine, ramipril, …) so the pipeline can distinguish "a medication is named but not in the dataset" (true negative) from "no medication named" (needs clarification).
- Cue lists for negation, historical, planned, other-person, and uncertainty classification, applied within a clause window around each entity so a cue binds to the nearest mention.

A live model would replace only the extraction step; the deterministic lookup and result-state logic are unchanged.

## Reproducibility

Re-running `npm run benchmark` on the same inputs produces identical `benchmark_results.json` (except `evalTimestamp`). The Benchmark page in the app reads every metric from that file — nothing is hardcoded in components.
