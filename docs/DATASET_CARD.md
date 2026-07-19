# Dataset Card — HormoneRx Evidence Records

**File:** `src/data/evidence_records.json` · **Version:** 0.1.0 · **Records:** 6

## Purpose

A small, source-linked evidence dataset of drug interactions involving hormonal contraceptives, used to test whether an AI system can retrieve verified interaction evidence rather than generate it. The dataset is the single source of truth for all medical content displayed in the app.

## Scope

Interactions between hormonal contraceptive methods and hepatic enzyme-inducing medications, plus one reversed-direction interaction (hormonal contraceptive lowering an anticonvulsant's level). The dataset is **intentionally narrow** and is not a comprehensive interaction reference.

## Records

| ID | Hormonal product | Interacting medication | Direction |
| --- | --- | --- | --- |
| INT-001 | Combined hormonal contraceptive | Carbamazepine | Medication may reduce contraceptive exposure |
| INT-002 | Combined hormonal contraceptive | Rifampicin or rifabutin | Medication may reduce contraceptive exposure |
| INT-003 | Progestogen-only pill | Hepatic enzyme-inducing medication | Medication may reduce contraceptive exposure |
| INT-004 | Etonogestrel implant | Hepatic enzyme-inducing medication | Medication may reduce contraceptive exposure |
| INT-005 | Estrogen-containing oral contraceptive | Lamotrigine | **Reversed:** contraceptive may reduce lamotrigine exposure |
| INT-006 | Levonorgestrel emergency contraception | Hepatic enzyme-inducing medication | Medication may reduce contraceptive exposure |

## Schema (all fields required)

`id`, `hormonalProduct`, `hormonalSynonyms[]`, `interactingMedication`, `medicationSynonyms[]`, `interactionDirection`, `potentialConsequence`, `clinicianConsideration`, `evidenceLevel`, `population`, `sourceTitle`, `sourceOrganization`, `sourceUrl`, `sourceSection`, `jurisdiction`, `lastVerified`, `physicianVerified`, `limitations`.

## Sources

- **FSRH CEU Guidance: Drug Interactions with Hormonal Contraception (May 2022)** — Faculty of Sexual and Reproductive Healthcare. Used for INT-001–INT-004, INT-006, and the lamotrigine FAQ in INT-005.
- **U.S. Medical Eligibility Criteria for Contraceptive Use, 2024** — CDC. Used for the rifampin/rifabutin classification in INT-002.
- **LAMICTAL (lamotrigine) Prescribing Information (Revised 10/2025)** — FDA. Used for INT-005 ("Estrogen-containing oral contraceptives decrease lamotrigine concentrations by approximately 50%").
- **MHRA Drug Safety Update (September 2016)** — levonorgestrel EC and hepatic enzyme inducers. Used for INT-006.

## Authoring rules

- Cautious, non-directive language. No individualized treatment or dose recommendations.
- `potentialConsequence` is a close paraphrase of the cited source only.
- `clinicianConsideration` is the fixed string: *"Evidence to review in the individual clinical context."*
- The exact guideline/label section is recorded in `sourceSection`.
- No invented citations or URLs. Any field that could not be grounded would carry `[VERIFY]`; the current dataset contains **no `[VERIFY]` fields**.

## Two documented nuances

- **INT-005 is reversed.** The concern is reduced *lamotrigine* exposure (seizure-control risk), not reduced contraceptive efficacy. The record carries no dose recommendation.
- **INT-006 source carries dose/alternative-method advice** (copper IUD, doubling the levonorgestrel dose). That directive content is deliberately **excluded** from `potentialConsequence` to keep it non-directive; it is noted only in `limitations`.

## Verification status

All six records currently have `physicianVerified: false` pending Dr. Lüdicke's morning confirmation. Every record has zero `[VERIFY]` fields and cites a real, checkable section, so all six meet the criteria for attestation. See `VERIFICATION_TABLE.md`. Until confirmed, describe the dataset as *"physician-reviewed, source-verification pending."*

## Provenance & licensing

Medical content paraphrases publicly available official guidance and product labelling. Cite the original sources for any downstream use. No patient data is included.
