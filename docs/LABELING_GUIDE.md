# Labeling Guide

Annotation rules for benchmark gold labels (Layers A, B, C). Gold labels are frozen
before evaluation and are never edited to improve metrics. Spec-driven semantic
relabels are documented in the case file (`relabeledInV2`) with the spec section.

## Status

| Label | Rule | Examples |
|---|---|---|
| `current` | Ongoing use stated or clearly implied | "I take X", "she is on X", "has just started X" |
| `historical` | Clearly ended use | "stopped X last year", "previously took X", "was on X" |
| `planned` | Future or proposed use, incl. doctor proposals | "planning to start X", "we will start X next week" |
| `negated` | Explicit denial | "not taking X", "denies X", "never used X" |
| `uncertain` | Identity or status unresolvable from the text | "something for her epilepsy", "the doctor explained what X is" |

Precedence within one clause: negated > historical > planned > uncertain-discussion > current.
Cues bind to the nearest entity (clause window), so "uses X but is not taking Y"
negates only Y.

## Subject

| Label | Rule |
|---|---|
| `patient` | First-person patient speech; third-person clinical-note phrasing ("she takes"); doctor statements about the patient ("you take", "we will start") |
| `other_person` | Possessive/relation cues: "my sister", "her partner", "a friend" |
| `doctor` | Doctor first-person self-medication ("I take X myself") |
| `unknown` | Attribution genuinely unclear (blocks matching, asks for clarification) |

Only patient-attributed assertions are eligible for warnings.

## Ambiguous hormonal references

"The pill", "oral contraceptive", "contraception", "birth control" without a method are
**ambiguous**: label `MORE_INFORMATION_REQUIRED` with the missing-method question. Never
resolve them to a specific product (spec §15.7). Class words ("enzyme inducer",
"barbiturates") are likewise never a medication identity.

## Corrections

A correction turn ("sorry, I meant lamotrigine"; "actually, I stopped it last year")
supersedes the earlier assertion. Expected labels cover both the new state and the
warning lifecycle: the stale warning must be `retracted` with a reason; a new record may
be matched in the same step. Where the spec allows two states after a correction, the
gold label lists the allowed set (`["RETRACTED", "EXCLUDED_CONTEXT"]`).

## Expected result state (single decision tree)

1. Active verified match → `EVIDENCE_FOUND` (proposed-context label if the medication is planned).
2. A warning was just invalidated → `RETRACTED` (visible reason required).
3. Unresolved ambiguity/uncertainty/contradiction or missing half of the pair → `MORE_INFORMATION_REQUIRED` with the specific missing item.
4. Relevant mention excluded (negated, historical, other person, discussed, cancelled) and no eligible pair → `EXCLUDED_CONTEXT`.
5. Clear pair, no record in the dataset → `NO_VALIDATED_MATCH` (+ mandatory not-established disclaimer).
6. Nothing relevant yet → `LISTENING`.

## Layer B extras

Per event: `expectedResultStates` (allowed set), `expectedEvidenceRecordIds`,
`expectedActiveWarningCount`, `expectRetractionWithReason`, `expectedWarningContext`,
plus `arrivesLate` / `isDuplicateReplay` transport flags.

## Layer C extras

Reference transcript per turn, critical entities (medication names, negations, temporal
qualifiers — errors on these count more than word-error rate), expected graph
assertions, expected state after each final turn, expected warning lifecycle.
