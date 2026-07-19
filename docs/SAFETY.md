# Safety

## The boundary (non-negotiable)

The language model may **only** extract structured context:

- hormonal product
- other medication
- normalized names
- status: current / historical / planned / negated / uncertain
- explicitly stated dose or route
- missing information
- whether a lookup should run

The model **must never** generate: interactions, consequences, mechanisms, evidence levels, citations, severity, or any treatment/dosing advice.

All visible medical content comes only from `src/data/evidence_records.json`. The app:

- never displays a green "safe" state;
- never claims that "no interaction exists";
- retains a persistent disclaimer on every screen.

**Persistent disclaimer:** *Research prototype. Not medical advice. Evidence is limited to the curated prototype dataset and requires verification against the cited source and individual clinical context.*

## How the boundary is enforced in code

- **Extraction output type** (`src/lib/types.ts` → `ExtractionResult`) is the only structure the model may produce. It contains no medical-claim fields.
- **Deterministic lookup** (`src/lib/lookup.ts`) decides the result state from normalized identifiers and documented synonyms. The model never decides the interaction.
- **Rendering** (`src/components/EvidenceRecordView.tsx`) shows only fields read from a matched record. Non-evidence states render fixed, non-medical strings (`NO_MATCH_PRIMARY`, `NO_MATCH_SECONDARY`).
- **Benchmark runner** counts an `unsupportedClaimCount`: any displayed message not traceable to the retrieved record or the allow-listed non-medical strings. It is currently **0**.

## Live mode secret handling

- Model name and API key are read **only** from server-side environment variables (`OPENAI_API_KEY`, `OPENAI_MODEL`).
- Do **not** prefix these with `VITE_`; that would inline them into client code.
- The browser calls a same-origin endpoint `/api/extract`; the model call happens server-side. See `api/extract.example.ts`.
- The endpoint must enforce the extraction-only schema and return an `ExtractionResult` and nothing else.

## Content specifically excluded

- **INT-005 (lamotrigine)** is the reversed-direction interaction (contraceptive lowers lamotrigine). It carries no dose recommendation.
- **INT-006 (levonorgestrel EC)** — the underlying MHRA source contains dose and alternative-method advice (copper IUD, doubling the dose). That directive content is deliberately excluded from the record's `potentialConsequence`.

## Out of scope (not built, by design)

Patient accounts, EHR, dosing tools, treatment recommendations, diagnosis, comprehensive drug coverage, and autonomous prescribing.
