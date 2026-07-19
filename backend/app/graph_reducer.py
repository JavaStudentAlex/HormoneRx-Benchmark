"""Encounter graph reducer: derives the current graph snapshot from the
append-only event log (spec §10, §11, §14, §15).

The reducer is deterministic: replaying the same event log always produces the
same assertions with the same IDs (assertion IDs derive from stored mention and
proposal IDs), so warnings that reference trigger assertions stay traceable
across rebuilds, late-event reorderings, and duplicate-replay tests.
"""
from __future__ import annotations

from datetime import datetime

from .evidence_index import EvidenceIndex
from .models import (
    Certainty,
    EncounterEvent,
    EventType,
    EvidenceMatch,
    GraphAssertion,
    MentionCategory,
    MentionStatus,
    NormalizationStatus,
    NormalizedMention,
    Predicate,
    PrescriptionProposal,
    SubjectRole,
    TranscriptTurn,
    WarningContext,
)

NON_INTERACTING_PREFIX = "non_interacting:"


def _predicate_for(category: MentionCategory, status: MentionStatus) -> Predicate | None:
    if status == MentionStatus.CURRENT:
        return Predicate.CURRENTLY_USES if category == MentionCategory.HORMONAL_PRODUCT else Predicate.CURRENTLY_TAKES
    if status == MentionStatus.HISTORICAL:
        return Predicate.HISTORICALLY_USED
    if status == MentionStatus.PLANNED:
        return Predicate.PLANS_TO_TAKE
    if status == MentionStatus.NEGATED:
        return Predicate.NEGATED_USE_OF
    return None  # uncertain mentions never become assertions


class GraphState:
    """Mutable rebuild product; converted into EncounterSnapshot fields by the service."""

    def __init__(self) -> None:
        self.turns: list[TranscriptTurn] = []
        self.mentions: list[NormalizedMention] = []
        self.assertions: dict[str, GraphAssertion] = {}
        self.proposals: dict[str, PrescriptionProposal] = {}
        self.supersession_events: list[dict] = []
        self.contradiction_notes: list[str] = []  # unresolved -> abstain
        self.conflict_notes: list[str] = []  # resolved polarity flips -> informational
        self.status: str = "created"
        self.started_at: datetime | None = None
        self.stopped_at: datetime | None = None

    def active(self) -> list[GraphAssertion]:
        return [a for a in self.assertions.values() if a.is_active]


class EncounterGraphReducer:
    def __init__(self, index: EvidenceIndex):
        self.index = index

    def rebuild(self, events: list[EncounterEvent]) -> GraphState:
        state = GraphState()

        # An encounter reset discards everything before it: only events after
        # the most recent SESSION_RESET participate in the derived graph.
        for i in range(len(events) - 1, -1, -1):
            if events[i].event_type == EventType.SESSION_RESET:
                events = events[i + 1 :]
                break

        # Transcript turns are ordered by the client-side turn sequence so a
        # late-arriving earlier turn is replayed in its correct position.
        turn_events = [e for e in events if e.event_type == EventType.TRANSCRIPT_FINAL_RECEIVED]
        extraction_by_turn: dict[str, EncounterEvent] = {}
        for e in events:
            if e.event_type == EventType.MENTIONS_EXTRACTED:
                extraction_by_turn[e.payload["turn_id"]] = e

        for e in events:
            if e.event_type == EventType.SESSION_STARTED:
                state.status = "listening"
                state.started_at = e.occurred_at
            elif e.event_type == EventType.SESSION_STOPPED:
                state.status = "stopped"
                state.stopped_at = e.occurred_at

        ordered_turn_events = sorted(turn_events, key=lambda e: (e.sequence, e.occurred_at))
        for turn_event in ordered_turn_events:
            turn = TranscriptTurn.model_validate(turn_event.payload["turn"])
            state.turns.append(turn)
            extraction_event = extraction_by_turn.get(turn.turn_id)
            if extraction_event is None:
                continue  # extraction failed for this turn; transcript retained
            normalized = [
                NormalizedMention.model_validate(m)
                for m in extraction_event.payload.get("normalized_mentions", [])
            ]
            corrections = extraction_event.payload.get("corrections", [])
            state.mentions.extend(normalized)
            self._apply_turn(state, turn, normalized, corrections)

        for e in events:
            if e.event_type == EventType.PRESCRIPTION_PROPOSED:
                proposal = PrescriptionProposal.model_validate(e.payload["proposal"])
                state.proposals[proposal.proposal_id] = proposal
                if proposal.concept_id:
                    self._add_assertion(
                        state,
                        assertion_id=f"a-prop-{proposal.proposal_id}",
                        subject=SubjectRole.PATIENT,
                        category=MentionCategory.OTHER_MEDICATION,
                        concept_id=proposal.concept_id,
                        canonical_name=proposal.canonical_name or proposal.concept_id,
                        status=MentionStatus.PLANNED,
                        source_turn_id=proposal.source_event_id or f"ui-proposal-{proposal.proposal_id}",
                        mention_id=None,
                        certainty=Certainty.EXPLICIT,
                        valid_from=proposal.created_at,
                        origin="ui_proposal",
                        proposal_id=proposal.proposal_id,
                    )
            elif e.event_type == EventType.PRESCRIPTION_CANCELLED:
                proposal_id = e.payload.get("proposal_id", "")
                proposal = state.proposals.get(proposal_id)
                if proposal and proposal.status != "cancelled":
                    state.proposals[proposal_id] = proposal.model_copy(
                        update={"status": "cancelled", "cancelled_at": e.occurred_at}
                    )
                assertion = state.assertions.get(f"a-prop-{proposal_id}")
                if assertion and assertion.is_active:
                    state.assertions[assertion.assertion_id] = assertion.model_copy(
                        update={"is_active": False, "valid_to": e.occurred_at}
                    )

        return state

    # -- per-turn application ----------------------------------------------

    def _apply_turn(
        self,
        state: GraphState,
        turn: TranscriptTurn,
        normalized: list[NormalizedMention],
        corrections: list[dict],
    ) -> None:
        # Same-concept contradictions inside a single turn resolve to uncertain.
        statuses_by_concept: dict[tuple[str, str], set[MentionStatus]] = {}
        for nm in normalized:
            if nm.concept_id and nm.mention.subject != SubjectRole.OTHER_PERSON:
                key = (nm.mention.subject.value, nm.concept_id)
                statuses_by_concept.setdefault(key, set()).add(nm.mention.status)
        contradictory = {
            key for key, statuses in statuses_by_concept.items()
            if len({s for s in statuses if s != MentionStatus.UNCERTAIN}) > 1
        }
        for subject, concept_id in contradictory:
            state.contradiction_notes.append(
                f"Contradictory statements about {self.index.ontology.canonical_name(concept_id)} "
                f"in turn {turn.turn_id} remain unresolved."
            )

        for nm in normalized:
            mention = nm.mention
            if nm.normalization_status in (NormalizationStatus.AMBIGUOUS, NormalizationStatus.UNKNOWN):
                continue  # never becomes an assertion; drives missing-information instead
            if nm.normalization_status == NormalizationStatus.NON_INTERACTING:
                concept_id = f"{NON_INTERACTING_PREFIX}{nm.canonical_name}"
                canonical = nm.canonical_name or mention.surface_text
            else:
                concept_id = nm.concept_id or ""
                canonical = nm.canonical_name or concept_id
            if not concept_id:
                continue
            if (mention.subject.value, nm.concept_id) in contradictory:
                continue
            predicate = _predicate_for(mention.category, mention.status)
            if predicate is None:
                continue
            self._add_assertion(
                state,
                assertion_id=f"a-{mention.mention_id}",
                subject=mention.subject,
                category=mention.category,
                concept_id=concept_id,
                canonical_name=canonical,
                status=mention.status,
                source_turn_id=turn.turn_id,
                mention_id=mention.mention_id,
                certainty=mention.certainty,
                valid_from=turn.received_at,
                normalization_method=nm.normalization_method,
            )

        # Explicit corrections: "sorry, I meant lamotrigine" / "I meant the combined
        # pill" supersede the most recent prior active assertion of the SAME category
        # for a different concept.
        for correction in corrections:
            replacement_surface = (correction.get("replacement_surface_text") or "").lower()
            if not replacement_surface:
                continue
            replacement_concept = self.index.alias_to_medication.get(replacement_surface)
            replacement_category = MentionCategory.OTHER_MEDICATION
            if not replacement_concept:
                replacement_concept = self.index.alias_to_hormonal.get(replacement_surface)
                replacement_category = MentionCategory.HORMONAL_PRODUCT
            if not replacement_concept:
                continue
            candidates = [
                a for a in state.active()
                if a.category == replacement_category
                and a.subject == SubjectRole.PATIENT
                and a.concept_id != replacement_concept
                and a.source_turn_id != turn.turn_id
            ]
            if not candidates:
                continue
            target = max(candidates, key=lambda a: a.valid_from)
            replacement_assertion = next(
                (
                    a for a in state.active()
                    if a.concept_id == replacement_concept and a.source_turn_id == turn.turn_id
                ),
                None,
            )
            state.assertions[target.assertion_id] = target.model_copy(
                update={
                    "is_active": False,
                    "valid_to": turn.received_at,
                    "superseded_by_assertion_id": replacement_assertion.assertion_id if replacement_assertion else None,
                }
            )
            state.supersession_events.append(
                {
                    "superseded": target.assertion_id,
                    "by": replacement_assertion.assertion_id if replacement_assertion else None,
                    "reason": "explicit correction",
                    "turn_id": turn.turn_id,
                }
            )
            replacement_name = self.index.ontology.canonical_name(replacement_concept)
            state.conflict_notes.append(
                f"{turn.turn_id} corrected the earlier statement: {target.canonical_name} → {replacement_name}."
            )
            if replacement_assertion:
                state.assertions[replacement_assertion.assertion_id] = replacement_assertion.model_copy(
                    update={"supersedes_assertion_id": target.assertion_id}
                )

    def _add_assertion(self, state: GraphState, **kwargs) -> None:
        normalization_method = kwargs.pop("normalization_method", "approved_synonym_index/0.2.0")
        assertion = GraphAssertion(
            predicate=_predicate_for(kwargs["category"], kwargs["status"]),  # type: ignore[arg-type]
            normalization_method=normalization_method,
            **kwargs,
        )
        # A new assertion for the same (subject, concept) supersedes the previous
        # active one — corrections, negations, and historicization all flow
        # through this single rule, preserving provenance on both sides.
        previous = next(
            (
                a for a in state.active()
                if a.subject == assertion.subject and a.concept_id == assertion.concept_id
                and a.assertion_id != assertion.assertion_id
            ),
            None,
        )
        if previous is not None:
            state.assertions[previous.assertion_id] = previous.model_copy(
                update={
                    "is_active": False,
                    "valid_to": assertion.valid_from,
                    "superseded_by_assertion_id": assertion.assertion_id,
                }
            )
            assertion = assertion.model_copy(update={"supersedes_assertion_id": previous.assertion_id})
            state.supersession_events.append(
                {
                    "superseded": previous.assertion_id,
                    "by": assertion.assertion_id,
                    "reason": f"new {assertion.status.value} statement about the same concept",
                    "turn_id": assertion.source_turn_id,
                }
            )
            # A polarity flip (current -> negated/historical, negated -> current, …)
            # is a resolved contradiction: the later statement wins, but the flip is
            # surfaced instead of silently applied.
            if previous.status != assertion.status and assertion.subject == SubjectRole.PATIENT:
                state.conflict_notes.append(
                    f"{assertion.source_turn_id} contradicts the earlier statement about "
                    f"{assertion.canonical_name} ({previous.status.value} → {assertion.status.value}); "
                    f"the later statement is used."
                )
        state.assertions[assertion.assertion_id] = assertion


# ---------------------------------------------------------------------------
# Pair eligibility (spec §16.5)
# ---------------------------------------------------------------------------

def eligible_pairs(state: GraphState, index: EvidenceIndex) -> list[tuple[GraphAssertion, GraphAssertion, WarningContext]]:
    # Danger-moment extension beyond spec §16.5 literal: a PLANNED hormonal product
    # with a current medication is checked as a proposed combination (spec §15.4
    # spirit — "planned may be checked"), so the warning appears at the moment the
    # prescription is being considered, not after it is issued.
    hormonal_active = [
        a for a in state.active()
        if a.subject == SubjectRole.PATIENT
        and a.category == MentionCategory.HORMONAL_PRODUCT
        and a.predicate in (Predicate.CURRENTLY_USES, Predicate.PLANS_TO_TAKE)
        and a.concept_id in index.ontology.hormonal_concepts
    ]
    medication_active = [
        a for a in state.active()
        if a.subject == SubjectRole.PATIENT
        and a.category == MentionCategory.OTHER_MEDICATION
        and a.predicate in (Predicate.CURRENTLY_TAKES, Predicate.PLANS_TO_TAKE)
        and a.concept_id in index.ontology.medication_concepts
    ]
    pairs: list[tuple[GraphAssertion, GraphAssertion, WarningContext]] = []
    for h in hormonal_active:
        for m in medication_active:
            context = (
                WarningContext.PROPOSED_COMBINATION
                if Predicate.PLANS_TO_TAKE in (m.predicate, h.predicate)
                else WarningContext.ACTIVE_COMBINATION
            )
            pairs.append((h, m, context))
    return pairs


def find_matches(state: GraphState, index: EvidenceIndex) -> list[EvidenceMatch]:
    matches: list[EvidenceMatch] = []
    for h, m, context in eligible_pairs(state, index):
        for record_id in index.lookup_pair(h.concept_id, m.concept_id):
            matches.append(
                EvidenceMatch(
                    record_id=record_id,
                    hormonal_concept_id=h.concept_id,
                    medication_concept_id=m.concept_id,
                    hormonal_assertion_id=h.assertion_id,
                    medication_assertion_id=m.assertion_id,
                    context=context,
                )
            )
    return matches
