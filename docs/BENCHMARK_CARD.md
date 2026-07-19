# Benchmark Card — HormoneRx Synthetic Consultation Benchmark

**File:** `src/data/benchmark_cases.json` · **Version:** 0.1.0 · **Cases:** 20

## Purpose

A labelled set of synthetic consultation snippets that tests whether a system can (1) recognize hormonal-contraceptive context, (2) normalize brand/misspelled names, (3) handle negation and temporality, (4) retrieve the correct evidence record, and (5) **abstain** when it should. Gold labels are manually curated and immutable.

## Composition

| Category | Count | Expected behavior |
| --- | --- | --- |
| `clear_positive` | 5 | Retrieve the correct record (EVIDENCE_FOUND) |
| `implicit_positive` | 3 | Retrieve via brand name / reversed direction / misspelling |
| `true_negative` | 3 | Named non-interacting drug → NO_VALIDATED_MATCH |
| `explicit_negation` | 3 | Negated or another person's med → EXCLUDED_CONTEXT / NO_VALIDATED_MATCH |
| `historical_use` | 2 | Past use → EXCLUDED_CONTEXT |
| `ambiguous_missing` | 4 | Unclear method / planned / unnamed med → MORE_INFORMATION_REQUIRED |

**Special elements embedded across the set:** a medication belonging to another person (CASE-014), a brand-vs-generic name (CASE-006), a misspelling (CASE-008), a planned-but-not-current medication (CASE-018), and multiple concurrent medications (CASE-003).

## Case schema

`id`, `category`, `input`, `expectedHormonalProduct`, `expectedMedication`, `expectedMedicationStatus`, `expectedResultState`, `expectedEvidenceRecordId`, `expectedAbstention`, `rationale`.

## Result states

- **EVIDENCE_FOUND** — a record was matched; only that record's fields are shown.
- **NO_VALIDATED_MATCH** — "No matching record was found in the current prototype evidence dataset." + "This does not establish that no interaction exists."
- **MORE_INFORMATION_REQUIRED** — missing/ambiguous information is listed; no guess.
- **EXCLUDED_CONTEXT** — a negated or historical mention was excluded from retrieval.
- **ERROR** — recoverable; no medical content.

## Constraints

- Uses only products and medications present in `evidence_records.json`.
- No real patient data.
- Gold labels are **not** changed to improve metrics.

## Intended use

Score any extraction system (deterministic or LLM) by running its extraction through the same deterministic lookup and comparing to gold labels. The most informative signals are the negation, temporality, and correct-abstention checks — a system that scores well on positives but fails to abstain is not safe.

## Known limitation

Because the synthetic cases are written in the dataset's own vocabulary, the bundled deterministic demo extractor scores at ceiling. This measures internal consistency of the harness, **not** clinical accuracy or real-world extraction difficulty. A live LLM run on paraphrased, noisier inputs is the harder and more meaningful test.
