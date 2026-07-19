"""Warning lifecycle reconciliation and result-state derivation (spec §17, §18).

A warning is a derived graph object. It is created only from a deterministic
evidence match over eligible patient assertions, is updated when its provenance
improves, and is visibly retracted — never silently dropped — when the context
that created it stops holding.
"""
from __future__ import annotations

from .evidence_index import EvidenceIndex
from .graph_reducer import NON_INTERACTING_PREFIX, GraphState, find_matches
from .models import (
    EvidenceMatch,
    MentionCategory,
    MentionStatus,
    NormalizationStatus,
    Predicate,
    ResultState,
    SubjectRole,
    TranscriptTurn,
    WarningRecord,
    new_id,
    utcnow,
)

DISPLAY_LABEL_ACTIVE = "Potentially relevant evidence found"
DISPLAY_LABEL_PROPOSED = "Potentially relevant evidence for the proposed medication combination"

NO_MATCH_PRIMARY = "No matching record was found in the current prototype evidence dataset."
NO_MATCH_SECONDARY = "This does not establish that no interaction exists."


class ReconcileOutcome:
    def __init__(self) -> None:
        self.warnings: list[WarningRecord] = []
        self.created: list[WarningRecord] = []
        self.updated: list[WarningRecord] = []
        self.retracted: list[WarningRecord] = []
        self.matches: list[EvidenceMatch] = []
        self.result_state: ResultState = ResultState.LISTENING
        self.lookup_reason: str = ""
        self.missing_information: list[str] = []
        self.excluded_notes: list[str] = []
        self.messages: list[str] = []


class WarningEngine:
    def __init__(self, index: EvidenceIndex):
        self.index = index

    # -- lifecycle ----------------------------------------------------------

    def reconcile(
        self,
        previous_warnings: list[WarningRecord],
        state: GraphState,
        latest_turn: TranscriptTurn | None,
    ) -> ReconcileOutcome:
        outcome = ReconcileOutcome()
        matches = find_matches(state, self.index)
        outcome.matches = matches

        def key_of_match(m: EvidenceMatch) -> tuple[str, str, str]:
            return (m.record_id, m.hormonal_concept_id, m.medication_concept_id)

        def key_of_warning(w: WarningRecord) -> tuple[str, str, str]:
            return (w.evidence_record_id, w.hormonal_concept_id, w.medication_concept_id)

        matches_by_key: dict[tuple[str, str, str], EvidenceMatch] = {}
        for m in matches:
            # An active combination outranks a proposed one for the same pair.
            existing = matches_by_key.get(key_of_match(m))
            if existing is None or existing.context.value == "proposed_combination":
                matches_by_key[key_of_match(m)] = m

        carried: list[WarningRecord] = []
        previous_active = [w for w in previous_warnings if w.state in ("active", "updated")]
        previous_retracted = [w for w in previous_warnings if w.state == "retracted"]

        for warning in previous_active:
            match = matches_by_key.pop(key_of_warning(warning), None)
            if match is None:
                reason = self._retraction_reason(warning, state, latest_turn)
                retracted = warning.model_copy(
                    update={
                        "state": "retracted",
                        "retracted_at": utcnow(),
                        "updated_at": utcnow(),
                        "retraction_reason": reason,
                        "retracted_by_turn_id": latest_turn.turn_id if latest_turn else None,
                    }
                )
                outcome.retracted.append(retracted)
                carried.append(retracted)
                continue
            new_triggers = [match.hormonal_assertion_id, match.medication_assertion_id]
            if new_triggers != warning.trigger_assertion_ids or match.context != warning.context:
                updated = warning.model_copy(
                    update={
                        "state": "updated",
                        "trigger_assertion_ids": new_triggers,
                        "context": match.context,
                        "display_label": (
                            DISPLAY_LABEL_PROPOSED
                            if match.context.value == "proposed_combination"
                            else DISPLAY_LABEL_ACTIVE
                        ),
                        "updated_at": utcnow(),
                    }
                )
                outcome.updated.append(updated)
                carried.append(updated)
            else:
                carried.append(warning)

        for match in matches_by_key.values():
            warning = WarningRecord(
                warning_id=new_id("warn"),
                state="active",
                display_label=(
                    DISPLAY_LABEL_PROPOSED
                    if match.context.value == "proposed_combination"
                    else DISPLAY_LABEL_ACTIVE
                ),
                evidence_record_id=match.record_id,
                context=match.context,
                verification_status=self.index.verification_status(match.record_id),
                hormonal_concept_id=match.hormonal_concept_id,
                medication_concept_id=match.medication_concept_id,
                trigger_assertion_ids=[match.hormonal_assertion_id, match.medication_assertion_id],
            )
            outcome.created.append(warning)
            carried.append(warning)

        outcome.warnings = carried + previous_retracted
        self._derive_result(outcome, state)
        return outcome

    # -- retraction explanations -------------------------------------------

    def _retraction_reason(
        self,
        warning: WarningRecord,
        state: GraphState,
        latest_turn: TranscriptTurn | None,
    ) -> str:
        med_name = self.index.ontology.canonical_name(warning.medication_concept_id)
        hor_name = self.index.ontology.canonical_name(warning.hormonal_concept_id)
        for proposal in state.proposals.values():
            if proposal.concept_id == warning.medication_concept_id and proposal.status == "cancelled":
                return f"The proposed prescription of {med_name} was cancelled."
        for concept_id, name in ((warning.medication_concept_id, med_name), (warning.hormonal_concept_id, hor_name)):
            assertions = [
                a for a in state.assertions.values()
                if a.concept_id == concept_id and a.subject == SubjectRole.PATIENT
            ]
            active = [a for a in assertions if a.is_active]
            if any(a.predicate == Predicate.HISTORICALLY_USED for a in active):
                return f"Current use of {name} was corrected to past (historical) use."
            if any(a.predicate == Predicate.NEGATED_USE_OF for a in active):
                return f"Use of {name} was negated by a later statement."
            if assertions and not active:
                return f"The assertion about {name} was superseded or cancelled."
        if latest_turn is not None:
            return "The medication context changed after a later finalized turn."
        return "The triggering context is no longer present in the encounter graph."

    # -- result-state derivation (spec §17) ---------------------------------

    def _derive_result(self, outcome: ReconcileOutcome, state: GraphState) -> None:
        active_warnings = [w for w in outcome.warnings if w.state in ("active", "updated")]

        patient_active = [
            a for a in state.active() if a.subject == SubjectRole.PATIENT
        ]
        hormonal_current = [
            a for a in patient_active
            if a.category == MentionCategory.HORMONAL_PRODUCT and a.predicate == Predicate.CURRENTLY_USES
        ]
        medication_current_or_planned = [
            a for a in patient_active
            if a.category == MentionCategory.OTHER_MEDICATION
            and a.predicate in (Predicate.CURRENTLY_TAKES, Predicate.PLANS_TO_TAKE)
        ]

        missing: list[str] = []
        excluded: list[str] = []

        # Ambiguous / unknown / uncertain mentions drive clarification requests.
        for nm in state.mentions:
            mention = nm.mention
            if mention.status == MentionStatus.NEGATED:
                continue
            if nm.normalization_status in (NormalizationStatus.AMBIGUOUS, NormalizationStatus.UNKNOWN):
                slot_filled = hormonal_current if mention.category == MentionCategory.HORMONAL_PRODUCT else medication_current_or_planned
                if nm.missing_information and not slot_filled:
                    missing.append(nm.missing_information)
            elif mention.status == MentionStatus.UNCERTAIN and nm.normalization_status == NormalizationStatus.NORMALIZED:
                excluded.append(
                    f"{nm.canonical_name} was discussed but not stated as a patient medication."
                )
        for note in state.contradiction_notes:
            missing.append(note)

        # Uncertain-surface mentions raised by the extractor itself.
        for nm in state.mentions:
            m = nm.mention
            if m.certainty.value == "uncertain" and m.surface_text.endswith("(name not stated)"):
                if not medication_current_or_planned:
                    missing.append("Specific medication name is not stated.")
            if m.certainty.value == "uncertain" and m.surface_text.startswith("contraception ("):
                if not hormonal_current:
                    missing.append("Specific hormonal contraceptive method is not stated.")

        # Unknown-subject current mentions block attribution.
        for nm in state.mentions:
            if (
                nm.mention.subject == SubjectRole.UNKNOWN
                and nm.mention.status == MentionStatus.CURRENT
                and nm.normalization_status == NormalizationStatus.NORMALIZED
            ):
                missing.append(
                    f"It is unclear whether {nm.canonical_name} refers to the patient."
                )

        # Excluded-context assertions (negated / historical / other person / cancelled).
        for a in state.assertions.values():
            name = a.canonical_name
            if a.subject == SubjectRole.OTHER_PERSON and a.is_active:
                excluded.append(f"{name} appears to belong to another person, not the patient.")
            elif a.subject == SubjectRole.PATIENT and a.is_active and a.predicate == Predicate.NEGATED_USE_OF:
                excluded.append(f"Use of {name} was explicitly negated.")
            elif a.subject == SubjectRole.PATIENT and a.is_active and a.predicate == Predicate.HISTORICALLY_USED:
                excluded.append(f"{name} was described as past (historical) use.")
        for p in state.proposals.values():
            if p.status == "cancelled":
                excluded.append(f"The proposed prescription of {p.canonical_name or p.surface_text} was cancelled.")

        outcome.missing_information = _dedupe(missing)
        outcome.excluded_notes = _dedupe(excluded)

        hormonal_relevant_missing = [m for m in outcome.missing_information]

        if active_warnings:
            outcome.result_state = ResultState.EVIDENCE_FOUND
            record_ids = sorted({w.evidence_record_id for w in active_warnings})
            outcome.lookup_reason = (
                "A verified-record lookup matched the current encounter graph "
                f"(record {', '.join(record_ids)})."
            )
            return

        if outcome.retracted:
            outcome.result_state = ResultState.RETRACTED
            outcome.lookup_reason = outcome.retracted[-1].retraction_reason or "A previously shown warning was retracted."
            return

        if hormonal_relevant_missing:
            outcome.result_state = ResultState.MORE_INFORMATION_REQUIRED
            outcome.lookup_reason = "The encounter graph does not yet contain enough unambiguous context for a deterministic lookup."
            return

        hormonal_filled = bool(hormonal_current)
        medication_filled = bool(medication_current_or_planned)

        if outcome.excluded_notes and not (hormonal_filled and medication_filled):
            outcome.result_state = ResultState.EXCLUDED_CONTEXT
            outcome.lookup_reason = "A relevant-sounding mention is excluded from matching by its context."
            return

        if hormonal_filled and medication_filled:
            outcome.result_state = ResultState.NO_VALIDATED_MATCH
            outcome.lookup_reason = "The medication context is clear but no record in the prototype evidence dataset matches this combination."
            outcome.messages = [NO_MATCH_PRIMARY, NO_MATCH_SECONDARY]
            return

        if hormonal_filled and not medication_filled:
            outcome.result_state = ResultState.MORE_INFORMATION_REQUIRED
            outcome.missing_information = _dedupe(
                outcome.missing_information + ["No current or proposed patient medication has been identified yet."]
            )
            outcome.lookup_reason = "A hormonal product is known but no other patient medication has been identified."
            return

        if medication_filled and not hormonal_filled:
            outcome.result_state = ResultState.MORE_INFORMATION_REQUIRED
            outcome.missing_information = _dedupe(
                outcome.missing_information + ["The hormonal contraceptive method (if any) is not yet known."]
            )
            outcome.lookup_reason = "A patient medication is known but the hormonal product context is not."
            return

        if outcome.excluded_notes:
            outcome.result_state = ResultState.EXCLUDED_CONTEXT
            outcome.lookup_reason = "A relevant-sounding mention is excluded from matching by its context."
            return

        outcome.result_state = ResultState.LISTENING
        outcome.lookup_reason = "No medication-relevant finalized turn has been analyzed yet."


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out
