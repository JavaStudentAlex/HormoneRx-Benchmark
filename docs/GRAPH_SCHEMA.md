# Encounter Graph Schema

Two conceptually separate graphs (spec §8):

- **Evidence graph** — curated, versioned, immutable at runtime
  (`backend/data/evidence_records.json` + `backend/data/synonym_index.json`).
- **Encounter graph** — temporary, event-sourced, rebuilt per consultation; never a
  permanent patient record.

They connect only through normalized concept IDs and verified record IDs.

## Event sourcing

The backend never mutates graph state directly. Every change is an appended event
(`SESSION_STARTED`, `TRANSCRIPT_FINAL_RECEIVED`, `MENTIONS_EXTRACTED`,
`PRESCRIPTION_PROPOSED/CANCELLED`, `WARNING_CREATED/UPDATED/RETRACTED`, …) and the
snapshot is derived by `EncounterGraphReducer.rebuild(event_log)`. Assertion IDs are
deterministic (`a-<mention_id>`, `a-prop-<proposal_id>`), so warnings stay traceable
across rebuilds, late events, and duplicate replays.

## Nodes

| Node | Key fields |
|---|---|
| TranscriptTurn | turn_id, sequence, speaker, text, is_final, arrived_late |
| NormalizedMention | surface_text, category, status, subject, certainty, span, concept_id, normalization_status (`normalized · ambiguous · non_interacting · unknown`) |
| GraphAssertion | assertion_id, subject, predicate, concept_id, status, source_turn_id, is_active, valid_from/to, supersedes / superseded_by, origin (`speech · ui_proposal`) |
| PrescriptionProposal | proposal_id, concept_id, status (`planned · cancelled`) |
| EvidenceMatch | record_id, hormonal/medication concept + assertion ids, context |
| WarningRecord | warning_id, state (`active · updated · retracted`), evidence_record_id, verification_status, trigger_assertion_ids, retraction_reason, retracted_by_turn_id |

## Predicates (assertion edges)

`CURRENTLY_USES · CURRENTLY_TAKES · HISTORICALLY_USED · PLANS_TO_TAKE · NEGATED_USE_OF`

Uncertain mentions (discussion-only, ambiguous "the pill", unrecallable names) never
become assertions — they drive `MORE_INFORMATION_REQUIRED` or excluded-context notes.

## Supersession rule

A new assertion for the same **(subject, concept)** deactivates the previous active one
and links both directions (`supersedes_assertion_id` / `superseded_by_assertion_id`).
Negation, historicization, and re-affirmation all flow through this one rule. Explicit
corrections ("sorry, I meant lamotrigine") additionally supersede the most recent prior
medication assertion for a **different** concept.

Same-turn contradictions about one concept (e.g. "I take X but I am not taking X")
produce **no** assertion: the concept is uncertain and the state machine abstains
(spec §15.9).

## Pair eligibility (spec §16.5)

`(active patient CURRENTLY_USES hormonal concept) × (active patient CURRENTLY_TAKES or
PLANS_TO_TAKE medication concept)` — both normalized to approved IDs. Negated,
historical, uncertain, other-person, doctor, and unknown-subject assertions never enter
the pair set. PLANS_TO_TAKE pairs are labeled **proposed combination**.

**Danger-moment extension (v0.2.1):** a *planned* hormonal product with a current
medication IS an eligible **proposed-combination** pair (beyond the spec §16.5 literal,
following §15.4's "planned may be checked") — so the warning appears while the
prescription is being *considered*. Resolved contradictions (polarity flips like
current→negated or a corrected pill product) are surfaced as **conflict notes** in the
result payload rather than silently applied; unresolved same-turn contradictions still
abstain. Mutually exclusive product groups (the three oral-pill concepts, declared in
`synonym_index.json`) trigger a clarification question when two are simultaneously
active, while warnings on both remain standing (cautious).

## Invariants (validated on every recompute, spec §16.4)

1. Active assertions have transcript/UI provenance.
2. Mentions link to one concept or are explicitly unknown/ambiguous.
3. Warnings reference only active trigger assertions…
4. …and only runtime-eligible evidence records.
5. No unverified record can trigger a warning (see the labeled demo override in `docs/SAFETY.md`).
6. Negated/historical assertions are never current.
7. Other-person assertions never enter the patient pair set.
8. Superseded assertions cannot stay active.
9. Retracted warnings cannot stay displayed as active.
10–12. All displayed medical content and sources come verbatim from the matched record; the model can never add an evidence edge.

Violations abort the update with `PROCESSING_ERROR` (no medical content shown) and are
logged in the event log.
