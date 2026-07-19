"""Graph consistency validation (spec §16.4).

Violations indicate an engine bug; they raise in tests and are logged and
converted to PROCESSING_ERROR at runtime rather than silently continuing.
"""
from __future__ import annotations

from .evidence_index import EvidenceIndex
from .graph_reducer import GraphState
from .models import MentionCategory, Predicate, SubjectRole, WarningRecord


class GraphInvariantViolation(Exception):
    def __init__(self, violations: list[str]):
        super().__init__("; ".join(violations))
        self.violations = violations


class GraphValidator:
    def __init__(self, index: EvidenceIndex):
        self.index = index

    def validate(self, state: GraphState, warnings: list[WarningRecord] | None = None) -> list[str]:
        violations: list[str] = []
        turn_ids = {t.turn_id for t in state.turns}
        assertion_ids = set(state.assertions.keys())

        for a in state.assertions.values():
            if a.is_active:
                # 1. Every active assertion has a source transcript turn or UI event.
                if a.origin == "speech" and a.source_turn_id not in turn_ids:
                    violations.append(f"active assertion {a.assertion_id} has no source turn")
                if a.origin == "ui_proposal" and not a.proposal_id:
                    violations.append(f"active UI assertion {a.assertion_id} has no proposal id")
                # 6. Negated and historical assertions are not "active current" state.
                if a.predicate in (Predicate.HISTORICALLY_USED, Predicate.NEGATED_USE_OF) and a.status.value == "current":
                    violations.append(f"assertion {a.assertion_id} predicate/status mismatch")
            # 8. A superseded assertion cannot remain active.
            if a.superseded_by_assertion_id and a.is_active:
                violations.append(f"assertion {a.assertion_id} superseded but still active")
            if a.supersedes_assertion_id and a.supersedes_assertion_id not in assertion_ids:
                violations.append(f"assertion {a.assertion_id} supersedes unknown assertion")

        # 2. Every mention links to one normalized concept or is explicitly unknown.
        for nm in state.mentions:
            if nm.normalization_status.value == "normalized" and not nm.concept_id:
                violations.append(f"mention {nm.mention.mention_id} normalized without concept id")

        for w in warnings or []:
            if w.state in ("active", "updated"):
                # 3. Every warning links to active trigger assertions.
                for aid in w.trigger_assertion_ids:
                    assertion = state.assertions.get(aid)
                    if assertion is None or not assertion.is_active:
                        violations.append(f"warning {w.warning_id} references inactive assertion {aid}")
                # 4./5. Warnings only from runtime-eligible records.
                report = self.index.reports.get(w.evidence_record_id)
                if report is None or not report.runtime_eligible:
                    violations.append(f"warning {w.warning_id} references ineligible record {w.evidence_record_id}")
                # 7. Other-person assertions never enter the patient pair set.
                for aid in w.trigger_assertion_ids:
                    assertion = state.assertions.get(aid)
                    if assertion and assertion.subject != SubjectRole.PATIENT:
                        violations.append(f"warning {w.warning_id} triggered by non-patient assertion {aid}")

        return violations

    def validate_or_raise(self, state: GraphState, warnings: list[WarningRecord] | None = None) -> None:
        violations = self.validate(state, warnings)
        if violations:
            raise GraphInvariantViolation(violations)
